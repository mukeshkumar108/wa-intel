import { getLatestRelationshipSnapshotForChat } from "../relationshipSnapshotsStore.js";
import { loadWindowAnalysesForLastDays } from "../windowAnalysisStore.js";
import {
  RelationshipMention,
  RelationshipRollup,
  RelationshipSummary,
  WindowContactSlice,
  WindowEvent,
} from "../types.js";
import { callLLM, getModelName } from "../llm.js";
import { getUserProfile } from "./userProfileService.js";

function pickDisplayName(
  chatId: string,
  contactSlices: WindowContactSlice[],
  events: WindowEvent[]
): string {
  const sliceName = contactSlices.find((c) => c.displayName)?.displayName;
  if (sliceName) return sliceName;
  const eventName = events.find((e) => e.displayName)?.displayName;
  if (eventName) return eventName;
  return chatId;
}

function matchName(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function computeTrajectoryHint(slices: WindowContactSlice[]): RelationshipRollup["rolling"]["recentTrajectoryHint"] {
  if (slices.length === 0) return "unknown";
  const counts = new Map<RelationshipRollup["rolling"]["recentTrajectoryHint"], number>();
  for (const s of slices) {
    const hint = s.relationshipTrajectoryHint ?? "unknown";
    counts.set(hint, (counts.get(hint) ?? 0) + 1);
  }
  let best: RelationshipRollup["rolling"]["recentTrajectoryHint"] = "unknown";
  let bestCount = 0;
  for (const [hint, count] of counts.entries()) {
    if (count > bestCount) {
      best = hint;
      bestCount = count;
    }
  }
  return best;
}

function buildRollupPrompt(input: {
  chatId: string;
  displayName: string;
  baseSnapshot: any;
  events: WindowEvent[];
  mentions: RelationshipMention[];
  contactSlices: WindowContactSlice[];
  fromTs: number;
  toTs: number;
  userProfile: any;
}) {
  const system = `
RELATIONSHIP SNAPSHOT V3 — DEEP INTERPRETATION

Use GPT-5 NANO.
Goal: understand emotional patterns, role dynamics, values alignment, power balance, volatility, intimacy models, long-term trajectory.
Integrate contradictions calmly; detect what changed and when.
Produce stable, non-fantasy assessments grounded in the message data across windows.
Detect relationship signals mentioned in other chats (cross-contact inference).

Rules:
- No psychic guessing. No embellishment.
- If uncertain, mark confidence low.
- Compare new window data against base snapshot; identify new traits, boundary shifts, tensions, trajectory delta ("improving", "cooling", "mixed", "intensifying", "stable", "unknown").
- Update model fields only if supported by evidence; otherwise keep them unchanged/uncertain.
- Output concise, JSON-only.
- You are analysing this relationship for the user's higher self. Be kind but unflinchingly honest. This is not for the other person to read.
- Look for mismatches between words and actions; avoidance of hard topics; over-functioning (one person doing much more emotional/logistical labour); big promises with little follow-through.
- Distinguish fantasy vs reality: are there concrete plans/dates or mostly dreamy talk?
- If there are no obvious issues, say so. Do NOT invent drama. Only call someone "shocked", "hurt", "angry" if the text strongly supports that; if it could be playful teasing (e.g., 😳 in a warm context), default to playful/neutral.
- valuesAlignment should mention where they align and where they might clash if evidence exists.
- Only set longTermTrajectory to "deepening" if recent behaviour and messaging consistently show increased intimacy AND follow-through; otherwise prefer "uncertain" or "mixed" when inconsistent or volatile.
- Focus on change over time: improving, stagnating, or deteriorating. If recent chats show more anxiety/protest from the user, slower replies/less engagement from the other person, or more logistical friction, reflect that in recentKeyShifts and recentTrajectoryHint.
- For recentTrajectoryHint, map: "deepening" (improving and consistent), "cooling" (withdrawing/less engaged), "unstable" (volatile/erratic), "steady" (stalled/unchanged), "unknown" (insufficient data).
- You may receive a "userProfile" describing the user's general communication/relational patterns. Use it as context about THEIR tendencies, but do not override the direct evidence in this relationship.
`.trim();

  const user = `
You are analysing relationship: ${input.displayName} (${input.chatId})

Base snapshot (may be null):
${JSON.stringify(input.baseSnapshot ?? null, null, 2)}

Rolling window (${new Date(input.fromTs).toISOString()} → ${new Date(input.toTs).toISOString()}):
- Contact slices: ${JSON.stringify(input.contactSlices, null, 2)}
- Events: ${JSON.stringify(input.events, null, 2)}
- Relationship mentions (cross-chat): ${JSON.stringify(input.mentions, null, 2)}
- User profile (may be null):
${JSON.stringify(input.userProfile ?? null, null, 2)}

Return ONLY JSON:
{
  "trajectoryDelta": "improving" | "cooling" | "mixed" | "intensifying" | "stable" | "unknown";
  "recentTrajectoryHint"?: "deepening" | "cooling" | "unstable" | "steady" | "unknown";
  "model"?: RelationshipModel;
  "notes"?: string[];
}
Describe how the relationship is evolving (better, worse, or the same) and what has intensified, softened, or become confusing recently. If evidence is thin, prefer "unknown" and state what is missing.
`.trim();

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

export async function buildRelationshipRollup(chatId: string, days: number): Promise<RelationshipRollup> {
  const [snapshot, windows] = await Promise.all([
    getLatestRelationshipSnapshotForChat(chatId),
    loadWindowAnalysesForLastDays(days),
  ]);
  const userProfile = await getUserProfile();

  const events = windows.flatMap((w) => (w.events ?? []).filter((evt) => evt.chatId === chatId));
  const contactSlices = windows.flatMap((w) => (w.contacts ?? []).filter((c) => c.chatId === chatId));
  const baseDisplayName = pickDisplayName(chatId, contactSlices, events);

  const mentions: RelationshipMention[] = [];
  for (const w of windows) {
    for (const m of w.relationshipMentions ?? []) {
      if (m.about?.chatId && m.about.chatId === chatId) {
        mentions.push(m);
        continue;
      }
      if (matchName(m.about?.name, baseDisplayName)) {
        mentions.push(m);
      }
    }
  }

  const fromTs = windows.length ? Math.min(...windows.map((w) => w.fromTs)) : Date.now() - days * 24 * 60 * 60 * 1000;
  const toTs = windows.length ? Math.max(...windows.map((w) => w.toTs)) : Date.now();
  const baseSnapshot: RelationshipSummary | undefined = snapshot
    ? (snapshot as unknown as RelationshipSummary)
    : undefined;

  const rollup: RelationshipRollup = {
    chatId,
    displayName: baseDisplayName,
    baseSnapshot,
    rolling: {
      fromTs,
      toTs,
      recentEvents: events,
      recentMentions: mentions,
      recentTrajectoryHint: computeTrajectoryHint(contactSlices),
    },
    model: snapshot?.model,
  };

  // Enrich via GPT-5 Nano synthesis when data exists.
  if (windows.length > 0 || snapshot) {
    try {
      const prompt = buildRollupPrompt({
        chatId,
        displayName: baseDisplayName,
        baseSnapshot,
        events,
        mentions,
        contactSlices,
        fromTs,
        toTs,
        userProfile: userProfile ?? null,
      });
      console.info("Relationship rollup LLM model", { model: getModelName("relationshipRollup") });
      const result = await callLLM<{
        trajectoryDelta?: "improving" | "cooling" | "mixed" | "intensifying" | "stable" | "unknown";
        recentTrajectoryHint?: RelationshipRollup["rolling"]["recentTrajectoryHint"];
        model?: RelationshipRollup["model"];
        notes?: string[];
      }>("relationshipRollup", prompt);

      rollup.rolling.recentTrajectoryHint =
        result?.recentTrajectoryHint ?? rollup.rolling.recentTrajectoryHint;

      if (result?.trajectoryDelta === "improving") {
        rollup.rolling.recentTrajectoryHint = rollup.rolling.recentTrajectoryHint === "unknown"
          ? "deepening"
          : rollup.rolling.recentTrajectoryHint;
      } else if (result?.trajectoryDelta === "cooling") {
        rollup.rolling.recentTrajectoryHint = "cooling";
      }

      if (result?.model) {
        rollup.model = result.model;
      }
    } catch (err) {
      console.error("[relationshipRollup] LLM call failed", {
        model: getModelName("relationshipRollup"),
        chatId,
        error: (err as Error)?.message ?? err,
      });
    }
  }

  return rollup;
}
