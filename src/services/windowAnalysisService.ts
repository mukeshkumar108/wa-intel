import crypto from "node:crypto";
import { getUserTimezoneOffsetHours } from "../config.js";
import { callLLM, getModelName } from "../llm.js";
import { toSummaryMessages, buildOpenLoopsPrompt, OpenLoopItem } from "../prompts.js";
import { loadWindowAnalysesBetween, loadWindowAnalysesForLastDays, loadRecentWindowAnalyses, saveWindowAnalysis } from "../windowAnalysisStore.js";
import { loadChatCheckpoints, saveChatCheckpoints, ChatCheckpoint } from "../stores/chatCheckpointStore.js";
import { fetchMessagesSince } from "../whatsappClient.js";
import {
  RelationshipMention,
  WindowAnalysis,
  WindowContactSlice,
  WindowEvent,
  WindowOpenLoop,
  MessageRecord,
} from "../types.js";

interface AnalyzeWindowParams {
  fromTs: number;
  toTs: number;
  force?: boolean;
}

interface WindowSummary {
  windows: WindowAnalysis[];
  summary: {
    moodTrend: "improving" | "worsening" | "stable" | "unknown";
    avgMood: string;
    avgStress: number;
    avgEnergy: number;
    topConcerns: string[];
  };
}

const WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hour default windows

function clamp(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalizeStringArray(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function normalizeOpenLoops(loops: any[], fallbackTs: number): WindowOpenLoop[] {
  if (!Array.isArray(loops)) return [];
  return loops
    .map((loop) => {
      const summaryRaw =
        typeof loop?.summary === "string"
          ? loop.summary
          : typeof loop?.what === "string"
            ? loop.what
            : typeof loop?.action === "string"
              ? loop.action
              : typeof loop?.description === "string"
                ? loop.description
                : typeof loop?.context === "string"
                  ? loop.context
                  : "";
      const summary = summaryRaw.trim();
      if (!summary) return null;
      const firstSeenTs = typeof loop?.firstSeenTs === "number" ? loop.firstSeenTs : fallbackTs;
      const lastSeenTs = typeof loop?.lastSeenTs === "number" ? loop.lastSeenTs : fallbackTs;
      const timesMentioned =
        typeof loop?.timesMentioned === "number" && Number.isFinite(loop.timesMentioned)
          ? loop.timesMentioned
          : 1;
      const importance =
        typeof loop?.importance === "number" && Number.isFinite(loop.importance)
          ? clamp(loop.importance, 1, 10, 5)
          : 5;
      const confidence =
        typeof loop?.confidence === "number" && Number.isFinite(loop.confidence)
          ? clamp(loop.confidence, 0, 1, 0.6)
          : 0.6;

      const rawLoopKey = typeof loop?.loopKey === "string" ? loop.loopKey : typeof loop?.loop_key === "string" ? loop.loop_key : undefined;
      const loopKey = (() => {
        if (!rawLoopKey) return undefined;
        const cleaned = rawLoopKey.toLowerCase().replace(/[^a-z0-9_]/g, "");
        if (cleaned.length < 3 || cleaned.length > 80) return undefined;
        return cleaned;
      })();

      const whenOptions = (() => {
        if (!Array.isArray(loop?.whenOptions)) return [];
        const seen = new Set<string>();
        const list: string[] = [];
        for (const item of loop.whenOptions) {
          if (typeof item !== "string") continue;
          const trimmed = item.trim();
          if (!trimmed) continue;
          if (seen.has(trimmed)) continue;
          seen.add(trimmed);
          list.push(trimmed);
          if (list.length >= 6) break;
        }
        return list;
      })();

      const isGroup =
        typeof loop?.isGroup === "boolean"
          ? loop.isGroup
          : typeof loop?.chatId === "string"
            ? loop.chatId.endsWith("@g.us")
            : undefined;

      const actorRaw = typeof loop?.actor === "string" && loop.actor.trim().length ? loop.actor : undefined;
      const displayNameRaw = typeof loop?.displayName === "string" && loop.displayName.trim().length ? loop.displayName : undefined;

      const inferredNeedsAction =
        typeof loop?.needsUserAction === "boolean"
          ? loop.needsUserAction
          : loop?.actor === "me" ||
              loop?.type === "invitation" ||
              loop?.type === "question" ||
              loop?.type === "time_sensitive"
            ? true
            : undefined;

      const normalised: WindowOpenLoop = {
        id: typeof loop?.id === "string" && loop.id.length ? loop.id : crypto.randomUUID(),
        chatId: loop?.chatId ?? "unknown",
        actor: actorRaw ?? displayNameRaw ?? "unknown",
        displayName: displayNameRaw,
        isGroup,
        type:
          loop?.type === "invitation" ||
          loop?.type === "promise" ||
          loop?.type === "question" ||
          loop?.type === "reminder" ||
          loop?.type === "emotional_follow_up" ||
          loop?.type === "time_sensitive" ||
          loop?.type === "other"
          ? loop.type
          : "other",
        loopKey,
        summary,
        when: typeof loop?.when === "string" ? loop.when : loop?.when ?? null,
        whenOptions,
        urgency: loop?.urgency === "high" || loop?.urgency === "moderate" ? loop.urgency : "low",
        importance,
        confidence,
        firstSeenTs,
        lastSeenTs,
        timesMentioned,
        status: loop?.status === "done" ? "done" : loop?.status === "dismissed" ? "dismissed" : "open",
        needsUserAction: inferredNeedsAction,
      };

      return normalised;
    })
    .filter((loop): loop is WindowOpenLoop => !!loop);
}

function normalizeContactSlices(raw: any[]): WindowContactSlice[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((slice) => {
      let importanceScore: number | undefined;
      if (typeof slice?.importanceScore === "number" && Number.isFinite(slice.importanceScore)) {
        importanceScore = clamp(slice.importanceScore, 1, 10, 5);
      }

      return {
        chatId: slice?.chatId ?? "unknown",
        displayName: slice?.displayName ?? slice?.chatId ?? "unknown",
        messagesFromMe: clamp(slice?.messagesFromMe, 0, Number.MAX_SAFE_INTEGER, 0),
        messagesFromThem: clamp(slice?.messagesFromThem, 0, Number.MAX_SAFE_INTEGER, 0),
        toneDescriptors: normalizeStringArray(slice?.toneDescriptors),
        relationshipRole: typeof slice?.relationshipRole === "string" ? slice.relationshipRole : undefined,
        importanceScore,
        relationshipTrajectoryHint:
          slice?.relationshipTrajectoryHint === "deepening" ||
          slice?.relationshipTrajectoryHint === "cooling" ||
          slice?.relationshipTrajectoryHint === "unstable" ||
          slice?.relationshipTrajectoryHint === "steady" ||
          slice?.relationshipTrajectoryHint === "unknown"
            ? slice.relationshipTrajectoryHint
            : "unknown",
        windowSummary: typeof slice?.windowSummary === "string" ? slice.windowSummary : undefined,
      };
    })
    .filter((slice) => typeof slice.chatId === "string");
}

function normalizeEvents(raw: any[]): WindowEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((evt) => {
      const category =
        evt?.category === "social" ||
        evt?.category === "romantic" ||
        evt?.category === "family" ||
        evt?.category === "work" ||
        evt?.category === "health" ||
        evt?.category === "money" ||
        evt?.category === "faith" ||
        evt?.category === "other"
          ? evt.category
          : "other";
      const impact = evt?.impact === "high" || evt?.impact === "medium" ? evt.impact : "low";

      const ts =
        typeof evt?.ts === "number" && Number.isFinite(evt.ts) ? evt.ts : Date.now();

      const normalised: WindowEvent = {
        ts,
        chatId: evt?.chatId ?? "unknown",
        displayName: evt?.displayName ?? evt?.chatId ?? "unknown",
        category,
        summary: evt?.summary ?? "",
        impact,
      };
      return normalised;
    })
    .filter((evt) => typeof evt.summary === "string" && evt.summary.trim().length > 0);
}

function normalizeRelationshipMentions(raw: any[]): RelationshipMention[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const confidence =
        typeof item?.confidence === "number" && Number.isFinite(item.confidence)
          ? clamp(item.confidence, 0, 1, 0.5)
          : 0.5;
      const ts =
        typeof item?.ts === "number" && Number.isFinite(item.ts) ? item.ts : Date.now();
      const mention: RelationshipMention = {
        about: {
          name: item?.about?.name ?? "unknown",
          chatId: item?.about?.chatId ?? null,
        },
        sourceChatId: item?.sourceChatId ?? "unknown",
        sourceDisplayName: item?.sourceDisplayName ?? item?.sourceChatId ?? "unknown",
        ts,
        howTheySpoke: item?.howTheySpoke ?? "neutral",
        summary: item?.summary ?? "",
        implication: typeof item?.implication === "string" ? item.implication : undefined,
        confidence,
      };
      return mention;
    })
    .filter((item) => typeof item.summary === "string" && item.summary.trim().length > 0);
}

function buildWindowAnalysisPrompt(messages: ReturnType<typeof toSummaryMessages>, window: { fromTs: number; toTs: number }) {
  const tzOffset = getUserTimezoneOffsetHours();

  const system = `
WINDOW ANALYSIS V2 — HIGH CLARITY, LOW FANTASY

Use only the visible messages to extract grounded insights. Avoid embellishment or speculation.
If messages conflict, keep both facts; do NOT resolve contradictions.
Extract mood, energy, stress, themes, events, and relationship mentions with zero guesswork.
Open loops must be EA-style actionable bullets: "Action → context → whether already completed → when required."
You are concise, specific, and allergic to fluff.
Return ONLY a JSON object that matches this TypeScript type exactly (no extra keys, no markdown):
{
  "id": string;
  "fromTs": number;
  "toTs": number;
  "generatedAt": number;
  "mood": "very_negative" | "mostly_negative" | "mixed" | "mostly_positive" | "very_positive";
  "energyLevel": number; // 0–100
  "stressLevel": number; // 0–100
  "dominantConcerns": string[];
  "selfTalkTone": string[];
  "underlyingThemes"?: string[];
  "contacts": WindowContactSlice[];
  "openLoops": WindowOpenLoop[];
  "events": WindowEvent[];
  "relationshipMentions": RelationshipMention[];
  "windowSummary": string;
}
`.trim();

  const compactMessages = messages
    .map((m) => {
      const speaker = m.fromMe ? "me" : m.displayName || "them";
      const body = JSON.stringify(m.body ?? "").slice(1, -1);
      return `- [${new Date(m.ts).toISOString()}] chatId=${m.chatId} ${speaker}: ${body}`;
    })
    .join("\n");

  const user = `
Window: ${new Date(window.fromTs).toISOString()} → ${new Date(window.toTs).toISOString()}
User timezone offset (hours from UTC): ${tzOffset}

Messages (chronological):
${compactMessages}

Use Llama 4 Scout (fast, factual). Return ONLY valid JSON, no markdown.
Rules:
- Be concise; keep only salient concerns, themes, and selfTalkTone signals grounded in text.
- contacts: per-contact slices with message counts (from me/them) and toneDescriptors; include relationshipRole/importanceScore/relationshipTrajectoryHint when clear; short windowSummary per contact if helpful.
- openLoops: Extract ONLY EA-grade actionable items: reply needed, decision needed, todo, event/date, or info-to-save. Exclude jokes, greetings, commentary, passive group chatter not involving "me", and anything already resolved in the window. Emit AT MOST 10 items; prefer fewer by consolidating. For scheduling/invites, emit ONE loop per intent even if dates/times vary. Put all variants into whenOptions (most recent first). Set when to best current option. Emit a stable loopKey per loop (lowercase snake_case, no dates, captures intent + target). Examples: schedule_meet_with_billy; reply_to_ashley_call_request; save_note_bishop_context. Set status="done" only if the messages clearly show completion/closure; otherwise open. actor must be me or the other person's display name; do not use "unknown" if you have it. If group chat and user did not participate, do NOT elevate it as the user's concern unless someone directly asks the user / tags them / requires their action. Ensure chatId and displayName are correct.
- openLoops: Extract ONLY EA-grade actionable items: reply needed, decision needed, todo, event/date, or info-to-save. Exclude jokes, greetings, commentary, passive group chatter not involving "me", and anything already resolved in the window. Emit AT MOST 10 items; prefer fewer by consolidating. For scheduling/invites, emit ONE loop per intent even if dates/times vary. Put all variants into whenOptions (most recent first). Set when to best current option. Emit a stable loopKey per loop (lowercase snake_case, no dates, captures intent + target). Examples: schedule_meet_with_billy; reply_to_ashley_call_request; save_note_bishop_context. If one party invites the other to meet/tea/coffee/trip and no time is set, output a single invitation loop (open) with loopKey + whenOptions. Set status="done" only if the messages clearly show completion/closure; otherwise open. actor must be me or the other person's display name; do not use "unknown" if you have it. If group chat and user did not participate, do NOT elevate it as the user's concern unless someone directly asks the user / tags them / requires their action. Ensure chatId and displayName are correct. Do NOT emit an openLoop if you cannot set chatId to the correct conversation; if unsure, omit it.
- events: concrete things that happened to the user.
- relationshipMentions: what the user said about someone in another chat (about{name/chatId}, sourceChatId/displayName, ts, howTheySpoke, summary, implication?, confidence).
- Mood/energy/stress reflect this window only. Do not invent causes. Do not hide contradictions.
- IMPORTANT RULES:
- Use the provided chat/contact metadata. If messages are in a 1:1 chat with a known romantic partner, do NOT describe that person as "family" unless the text explicitly says they are family.
- Do NOT guess at relationships. If you don't know if someone is family, partner, or friend, say "unknown" or "unclear".
- Do NOT invent life changes or hidden motives (e.g., "relocation hints", "secret plans") unless the messages explicitly state them.
- When summarising events like travel, be precise: "Ashley returning from a work trip" is only valid if the text clearly supports that. Otherwise: "contact returning from a trip".
- When in doubt, describe what is observable in the messages, not what might be true.
- For each window, you are given chatId/displayName for messages; treat displayName as the primary identity. If messages clearly reference "my mum/dad/brother/sister/kids", that is family; otherwise keep relationshipRole unknown.
- Emotional interpretation: only call out strong emotions ("shocked", "devastated", "angry", "jealous") if the text clearly shows that. If tone could be playful OR shocked (e.g., 😳 in an otherwise warm/flirty context), default to playful surprise or neutral phrasing ("reacted playfully", "mild surprise") instead of intense emotion.
`.trim();

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

type ContactMeta = {
  chatId: string;
  displayName: string;
  isGroup: boolean;
  messagesFromMe: number;
  messagesFromThem: number;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function mapCategoryToType(cat: OpenLoopItem["category"] | undefined): WindowOpenLoop["type"] {
  switch (cat) {
    case "promise":
      return "promise";
    case "follow_up":
      return "reminder";
    case "question":
      return "question";
    case "time_sensitive":
      return "time_sensitive";
    default:
      return "other";
  }
}

async function extractOpenLoopsPerChat(
  messages: ReturnType<typeof toSummaryMessages>,
  contactMeta: ContactMeta[],
  opts: { force: boolean; checkpoints: Record<string, ChatCheckpoint>; debug?: boolean }
): Promise<{
  loops: WindowOpenLoop[];
  perChatSummary: Record<
    string,
    { chatSummary?: string; chatMood?: any; chatThemes?: string[]; chatTone?: string[]; keyMoments?: any; asksFromThem?: number; asksFromMe?: number }
  >;
  checkpointUpdates: Record<string, ChatCheckpoint>;
}> {
  const msgsByChat = new Map<string, ReturnType<typeof toSummaryMessages>>();
  for (const m of messages) {
    const list = msgsByChat.get(m.chatId) ?? [];
    list.push(m);
    msgsByChat.set(m.chatId, list);
  }

  const messageById = new Map<string, typeof messages[number]>();
  for (const m of messages) messageById.set(m.id, m);

  const results: WindowOpenLoop[] = [];
  const perChatSummary: Record<
    string,
    { chatSummary?: string; chatMood?: any; chatThemes?: string[]; chatTone?: string[]; keyMoments?: any; asksFromThem?: number; asksFromMe?: number }
  > = {};
  const checkpointUpdates: Record<string, ChatCheckpoint> = {};

  for (const [chatId, list] of msgsByChat.entries()) {
    list.sort((a, b) => a.ts - b.ts);

    let promptMessages = list.slice(-150);
    let willProcess = true;

    if (!opts.force) {
      const cp = opts.checkpoints[chatId];
      const lastTs = cp?.lastProcessedTs ?? 0;
      const newer = list.filter((m) => m.ts > lastTs);

      if (newer.length === 0) {
        willProcess = false;
        if (opts.debug) {
          console.info("[openLoops][skip]", { chatId, lastProcessedTs: lastTs, newMsgs: 0 });
        }
      } else {
        const overlapCount = 10;
        const overlap = list.filter((m) => m.ts <= lastTs).slice(-overlapCount);
        const combined = [...overlap, ...newer];
        const hardCap = 220;
        promptMessages = combined.slice(-hardCap);
        if (promptMessages.length > 200) {
          const recent = newer.slice(-200);
          const extraOverlap = combined.slice(Math.max(0, combined.length - 220), combined.length - recent.length);
          promptMessages = [...extraOverlap, ...recent];
        }
        if (opts.debug) {
          console.info("[openLoops][process]", {
            chatId,
            lastProcessedTs: lastTs,
            newMsgs: newer.length,
            overlap: Math.min(overlapCount, overlap.length),
            promptCount: promptMessages.length,
          });
        }
      }
    }

    if (!willProcess) continue;

    const prompt = buildOpenLoopsPrompt(promptMessages);
    let resp: {
      openLoops: OpenLoopItem[];
      chatSummary?: string;
      chatMood?: any;
      chatThemes?: string[];
      chatTone?: string[];
      keyMoments?: any;
      asksFromThem?: number;
      asksFromMe?: number;
    } = {
      openLoops: [],
    };
    try {
      resp = await callLLM<typeof resp>("openLoops", prompt);
    } catch (err) {
      console.error("[windowAnalysis] per-chat openLoops LLM failed", { chatId, err });
      continue;
    }

    const contact = contactMeta.find((c) => c.chatId === chatId);

    for (const loop of resp.openLoops ?? []) {
      const msg = messageById.get(loop.messageId);
      const ts = msg?.ts ?? promptMessages[promptMessages.length - 1]?.ts ?? Date.now();
      const actor = loop.who || (msg?.fromMe ? "me" : msg?.displayName || contact?.displayName || "unknown");
      const intentKey = (loop as any)?.intentKey ? slugify((loop as any).intentKey) : undefined;
      const intentLabels =
        Array.isArray((loop as any)?.intentLabels)
          ? (loop as any).intentLabels
              .filter((t: any) => typeof t === "string")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : undefined;
      const summary =
        loop.what?.trim() ||
        loop.when?.trim() ||
        slugify((loop as any).loopKey ?? "") ||
        "Pending action";

      const loopKey = (loop as any).loopKey
        ? slugify((loop as any).loopKey)
        : slugify(`${chatId}_${summary.slice(0, 50) || "loop"}`);

      const whenOptions: string[] = [];
      if (loop.when && typeof loop.when === "string" && loop.when.trim()) {
        whenOptions.push(loop.when.trim());
      }

      results.push({
        id: loop.messageId || crypto.randomUUID(),
        chatId,
        actor,
        displayName: contact?.displayName,
        isGroup: contact?.isGroup,
        type: mapCategoryToType(loop.category),
        loopKey,
        intentKey,
        intentLabels,
        summary,
        when: loop.when ?? null,
        whenOptions,
        urgency: (loop as any)?.urgency === "high" || (loop as any)?.urgency === "moderate" ? (loop as any).urgency : "low",
        importance: typeof (loop as any)?.importance === "number" ? clamp((loop as any).importance, 1, 10, 5) : 5,
        confidence: typeof (loop as any)?.confidence === "number" ? clamp((loop as any).confidence, 0, 1, 0.6) : 0.6,
        firstSeenTs: ts,
        lastSeenTs: ts,
        timesMentioned: 1,
        status: (loop as any)?.status === "done" ? "done" : "open",
        needsUserAction: true,
      });
    }

    perChatSummary[chatId] = {
      chatSummary: typeof resp.chatSummary === "string" ? resp.chatSummary : undefined,
      chatMood: resp.chatMood,
      chatThemes: Array.isArray(resp.chatThemes) ? resp.chatThemes.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : undefined,
      chatTone: Array.isArray(resp.chatTone) ? resp.chatTone.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : undefined,
      keyMoments: Array.isArray(resp.keyMoments)
        ? resp.keyMoments
            .filter((m) => m?.messageId && m?.summary)
            .map((m) => ({
              messageId: m.messageId,
              summary: String(m.summary).trim(),
              who: typeof m.who === "string" ? m.who : "unknown",
            }))
        : undefined,
      asksFromThem: typeof resp.asksFromThem === "number" ? resp.asksFromThem : undefined,
      asksFromMe: typeof resp.asksFromMe === "number" ? resp.asksFromMe : undefined,
    };

    // checkpoint update on success
    const maxTs = promptMessages[promptMessages.length - 1]?.ts ?? 0;
    if (maxTs > 0) {
      checkpointUpdates[chatId] = {
        chatId,
        lastProcessedTs: maxTs,
        lastProcessedMessageId: promptMessages[promptMessages.length - 1]?.id,
        updatedAt: Date.now(),
      };
    }
  }

  // Deduplicate within chat: use loopKey if present else normalized summary
  const merged: WindowOpenLoop[] = [];
  const dedupeByChat = new Map<string, Map<string, WindowOpenLoop>>();

  function normalizeSummary(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\b\d{1,2}(st|nd|rd|th)?\b/g, " ")
      .replace(/\b(mon|tue|tues|wed|thu|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  for (const loop of results) {
    const chatId = loop.chatId;
    const key =
      loop.intentKey ||
      loop.loopKey ||
      `${chatId}|${normalizeSummary(loop.summary || "") || normalizeSummary(loop.when || "") || "loop"}`;
    const chatMap = dedupeByChat.get(chatId) ?? new Map<string, WindowOpenLoop>();
    const existing = chatMap.get(key);
    if (!existing) {
      // normalize displayName from contactMeta
      const contact = contactMeta.find((c) => c.chatId === chatId);
      chatMap.set(key, {
        ...loop,
        displayName: contact?.displayName ?? loop.displayName,
      });
    } else {
      const mergedLoop: WindowOpenLoop = {
        ...existing,
        intentKey: existing.intentKey || loop.intentKey,
        intentLabels: Array.from(new Set([...(existing.intentLabels ?? []), ...(loop.intentLabels ?? [])])),
        summary: loop.summary?.length > (existing.summary?.length ?? 0) ? loop.summary : existing.summary,
        when: loop.when ?? existing.when,
        whenOptions: Array.from(new Set([...(existing.whenOptions ?? []), ...(loop.whenOptions ?? [])])),
        urgency: ((): WindowOpenLoop["urgency"] => {
          const rank: Record<WindowOpenLoop["urgency"], number> = { high: 3, moderate: 2, low: 1 };
          const lu = loop.urgency ?? "low";
          const eu = existing.urgency ?? "low";
          return rank[lu] > rank[eu] ? lu : eu;
        })(),
        importance: Math.max(existing.importance ?? 0, loop.importance ?? 0),
        confidence: Math.max(existing.confidence ?? 0, loop.confidence ?? 0),
        timesMentioned: (existing.timesMentioned ?? 1) + (loop.timesMentioned ?? 1),
        firstSeenTs: Math.min(existing.firstSeenTs ?? Date.now(), loop.firstSeenTs ?? Date.now()),
        lastSeenTs: Math.max(existing.lastSeenTs ?? Date.now(), loop.lastSeenTs ?? Date.now()),
        status: existing.status === "done" || loop.status === "done" ? "done" : "open",
      };
      chatMap.set(key, mergedLoop);
    }
    dedupeByChat.set(chatId, chatMap);
  }

  for (const chatMap of dedupeByChat.values()) {
    for (const loop of chatMap.values()) merged.push(loop);
  }

  const capped = merged.slice(0, 5);

  return { loops: capped, perChatSummary, checkpointUpdates };
}

function normaliseWindowAnalysis(
  raw: Partial<WindowAnalysis>,
  window: { fromTs: number; toTs: number },
  contactMeta: ContactMeta[] = []
): WindowAnalysis {
  const midpoint = Math.floor((window.fromTs + window.toTs) / 2);

  const contactsFromLLM = normalizeContactSlices(raw.contacts ?? []);
  const contactsFromMeta: WindowContactSlice[] = contactMeta.map((c) => ({
    chatId: c.chatId,
    displayName: c.displayName,
    messagesFromMe: c.messagesFromMe,
    messagesFromThem: c.messagesFromThem,
    toneDescriptors: [],
    relationshipRole: "unknown",
    importanceScore: undefined,
    relationshipTrajectoryHint: "unknown",
    windowSummary: undefined,
  }));

  const contactPoolMap = new Map<string, WindowContactSlice>();
  for (const c of [...contactsFromLLM, ...contactsFromMeta]) {
    if (!c?.chatId) continue;
    if (!contactPoolMap.has(c.chatId)) {
      contactPoolMap.set(c.chatId, c);
    }
  }
  const contacts = Array.from(contactPoolMap.values());

  const openLoops = normalizeOpenLoops(raw.openLoops ?? [], midpoint)
    .map((loop) => ({
      ...loop,
      firstSeenTs: typeof loop.firstSeenTs === "number" ? loop.firstSeenTs : midpoint,
      lastSeenTs: typeof loop.lastSeenTs === "number" ? loop.lastSeenTs : midpoint,
      timesMentioned: loop.timesMentioned ?? 1,
      id: loop.id ?? crypto.randomUUID(),
    }))
    .map((loop) => {
      // If chatId is unknown, try to infer from contacts
      if (loop.chatId && loop.chatId !== "unknown") return loop;

      // Exact displayName match
      const matched = contacts.find(
        (c) => typeof loop.actor === "string" && c.displayName.toLowerCase() === loop.actor.toLowerCase()
      );
      if (matched) {
        return {
          ...loop,
          chatId: matched.chatId,
          displayName: matched.displayName,
          isGroup: matched.chatId.endsWith("@g.us"),
        };
      }

      // Single contact window fallback
      if (contacts.length === 1) {
        const only = contacts[0];
        return {
          ...loop,
          chatId: only.chatId,
          displayName: only.displayName,
          isGroup: only.chatId.endsWith("@g.us"),
        };
      }

      // Choose the contact with highest message volume in this window
      const withVolume = contacts
        .map((c) => ({
          ...c,
          volume: (c.messagesFromMe ?? 0) + (c.messagesFromThem ?? 0),
        }))
        .sort((a, b) => b.volume - a.volume);
      if (withVolume.length > 0) {
        const top = withVolume[0];
        return {
          ...loop,
          chatId: top.chatId,
          displayName: top.displayName,
          isGroup: top.chatId.endsWith("@g.us"),
        };
      }

      return loop;
    });

  const events = normalizeEvents(raw.events ?? []).map((evt) => ({
    ...evt,
    ts: typeof evt.ts === "number" ? evt.ts : midpoint,
  }));

  const relationshipMentions = normalizeRelationshipMentions(raw.relationshipMentions ?? []);

  return {
    id: raw.id ?? crypto.randomUUID(),
    fromTs: window.fromTs,
    toTs: window.toTs,
    generatedAt: raw.generatedAt ?? Date.now(),
    modelUsed: raw.modelUsed ?? getModelName("window"),
    mood:
      raw.mood === "very_negative" ||
      raw.mood === "mostly_negative" ||
      raw.mood === "mixed" ||
      raw.mood === "mostly_positive" ||
      raw.mood === "very_positive"
        ? raw.mood
        : "mixed",
    energyLevel: clamp(raw.energyLevel, 0, 100, 50),
    stressLevel: clamp(raw.stressLevel, 0, 100, 50),
    dominantConcerns: (() => {
      const concerns = normalizeStringArray(raw.dominantConcerns);
      const anyUserMsgs = contacts.some((c) => (c.messagesFromMe ?? 0) > 0);
      return anyUserMsgs ? concerns : [];
    })(),
    selfTalkTone: normalizeStringArray(raw.selfTalkTone),
    underlyingThemes: (() => {
      const themes = normalizeStringArray(raw.underlyingThemes);
      return themes.length ? themes : undefined;
    })(),
    contacts,
    openLoops,
    events,
    relationshipMentions,
    windowSummary: typeof raw.windowSummary === "string" && raw.windowSummary.trim().length > 0
      ? raw.windowSummary
      : "No notable summary captured.",
  };
}

export async function analyzeWindow(params: AnalyzeWindowParams): Promise<WindowAnalysis> {
  const { fromTs, toTs } = params;
  const force = !!params.force;

  if (!force) {
    const existing = await loadWindowAnalysesBetween(fromTs, toTs);
    const exact = existing.find((wa) => wa.fromTs === fromTs && wa.toTs === toTs);
    if (exact) return exact;
  }

  let rawMessages: MessageRecord[] = [];
  try {
    // Use the window start as-is; if source data is forward-dated, we still want those messages.
    rawMessages = await fetchMessagesSince(fromTs, 2000);
  } catch (err) {
    console.error("Failed to fetch messages for window", { fromTs, toTs, err });
    rawMessages = [];
  }

  const windowMessages = rawMessages.filter((m) => m.ts >= fromTs && m.ts <= toTs);
  windowMessages.sort((a, b) => a.ts - b.ts);

  const summaryMessages = toSummaryMessages(windowMessages);
  const contactMeta: ContactMeta[] = (() => {
    const byChat = new Map<string, ContactMeta>();
    for (const m of summaryMessages) {
      const existing = byChat.get(m.chatId) ?? {
        chatId: m.chatId,
        displayName: m.displayName || m.chatId,
        isGroup: m.chatId.endsWith("@g.us"),
        messagesFromMe: 0,
        messagesFromThem: 0,
      };
      if (m.fromMe) existing.messagesFromMe += 1;
      else existing.messagesFromThem += 1;
      if (m.displayName && (!existing.displayName || existing.displayName === existing.chatId)) {
        existing.displayName = m.displayName;
      }
      byChat.set(m.chatId, existing);
    }
    return Array.from(byChat.values());
  })();

  if (summaryMessages.length === 0) {
    const empty = normaliseWindowAnalysis(
      {
        mood: "mixed",
        energyLevel: 0,
        stressLevel: 0,
        dominantConcerns: [],
        selfTalkTone: [],
        contacts: [],
        openLoops: [],
        events: [],
        relationshipMentions: [],
        windowSummary: "No messages in this window.",
        modelUsed: getModelName("window"),
      },
      { fromTs, toTs },
      contactMeta
    );
    await saveWindowAnalysis(empty);
    return empty;
  }

  const prompt = buildWindowAnalysisPrompt(summaryMessages, { fromTs, toTs });
  console.info("Window analysis LLM model", { model: getModelName("window") });
  let rawAnalysis: Partial<WindowAnalysis> = {};
  try {
    rawAnalysis = await callLLM<Partial<WindowAnalysis>>("window", prompt);
    console.info("[windowAnalysis] LLM response stats", {
      fromTs,
      toTs,
      messages: summaryMessages.length,
      openLoops: Array.isArray((rawAnalysis as any)?.openLoops) ? (rawAnalysis as any).openLoops.length : "none",
    });
    if (Array.isArray((rawAnalysis as any)?.openLoops) && (rawAnalysis as any).openLoops.length > 0) {
      console.info("[windowAnalysis] sample openLoops", JSON.stringify((rawAnalysis as any).openLoops.slice(0, 3), null, 2));
    }
  } catch (err) {
    console.error("[windowAnalysis] LLM call failed", {
      model: getModelName("window"),
      fromTs,
      toTs,
      error: (err as Error)?.message ?? err,
    });
    rawAnalysis = {
      mood: "mixed",
      energyLevel: 0,
      stressLevel: 0,
      dominantConcerns: [],
      selfTalkTone: [],
      contacts: [],
      openLoops: [],
      events: [],
      relationshipMentions: [],
      windowSummary: "LLM unavailable; placeholder snapshot.",
    };
  }

  // Per-chat open loop extraction (more reliable chat attribution) + chat summary/mood/themes
  try {
    const checkpoints = force ? {} : await loadChatCheckpoints();
    const { loops, perChatSummary, checkpointUpdates } = await extractOpenLoopsPerChat(summaryMessages, contactMeta, {
      force,
      checkpoints,
      debug: process.env.DEBUG_INTEL === "1",
    });
    rawAnalysis.openLoops = loops;
    // Merge per-chat summaries back into contacts
    if (rawAnalysis.contacts && Array.isArray(rawAnalysis.contacts)) {
      rawAnalysis.contacts = rawAnalysis.contacts.map((c: any) => {
        const per = perChatSummary[c.chatId];
        if (!per) return c;
        return {
          ...c,
          windowSummary: c.windowSummary || per.chatSummary,
          toneDescriptors:
            c.toneDescriptors && c.toneDescriptors.length
              ? c.toneDescriptors
              : per.chatTone,
          dominantConcerns:
            c.dominantConcerns && c.dominantConcerns.length
              ? c.dominantConcerns
              : per.chatThemes,
          moments: per.keyMoments ?? c.moments,
          asksFromThem: per.asksFromThem ?? c.asksFromThem,
          asksFromMe: per.asksFromMe ?? c.asksFromMe,
        };
      });
    }
    // Persist checkpoints (only for processed chats)
    if (!force && Object.keys(checkpointUpdates).length > 0) {
      const updated = { ...(await loadChatCheckpoints()), ...checkpointUpdates };
      await saveChatCheckpoints(updated);
    }
  } catch (err) {
    console.error("[windowAnalysis] per-chat openLoops extraction failed", { fromTs, toTs, err });
  }

  const normalised = normaliseWindowAnalysis(
    { ...rawAnalysis, modelUsed: getModelName("window") },
    { fromTs, toTs },
    contactMeta
  );
  await saveWindowAnalysis(normalised);
  return normalised;
}

export async function backfillWindowsForLastHours(hours: number, force = false): Promise<WindowAnalysis[]> {
  const now = Date.now();
  const start = now - hours * 60 * 60 * 1000;

  const analyses: WindowAnalysis[] = [];

  for (let cursor = start; cursor < now; cursor += WINDOW_MS) {
    const fromTs = cursor;
    const toTs = Math.min(cursor + WINDOW_MS - 1, now);

    if (!force) {
      const existing = await loadWindowAnalysesBetween(fromTs, toTs);
      const exact = existing.find((wa) => wa.fromTs === fromTs && wa.toTs === toTs);
      if (exact) {
        analyses.push(exact);
        continue;
      }
    }

    try {
      const analysis = await analyzeWindow({ fromTs, toTs, force });
      analyses.push(analysis);
    } catch (err) {
      console.error("Failed to analyze window", { fromTs, toTs, err });
    }
  }

  return analyses;
}

function mapMoodToScore(mood: WindowAnalysis["mood"]): number {
  switch (mood) {
    case "very_negative":
      return -2;
    case "mostly_negative":
      return -1;
    case "mixed":
      return 0;
    case "mostly_positive":
      return 1;
    case "very_positive":
      return 2;
    default:
      return 0;
  }
}

function mapScoreToMood(score: number): WindowAnalysis["mood"] {
  if (score >= 1.5) return "very_positive";
  if (score >= 0.5) return "mostly_positive";
  if (score <= -1.5) return "very_negative";
  if (score <= -0.5) return "mostly_negative";
  return "mixed";
}

function computeMoodTrend(windows: WindowAnalysis[]): "improving" | "worsening" | "stable" | "unknown" {
  if (windows.length < 2) return "unknown";
  const sorted = [...windows].sort((a, b) => a.fromTs - b.fromTs);
  const chunk = Math.max(1, Math.floor(sorted.length / 3));
  const early = sorted.slice(0, chunk);
  const late = sorted.slice(-chunk);
  const avgEarly = early.reduce((sum, w) => sum + mapMoodToScore(w.mood), 0) / early.length;
  const avgLate = late.reduce((sum, w) => sum + mapMoodToScore(w.mood), 0) / late.length;
  const delta = avgLate - avgEarly;
  if (delta > 0.3) return "improving";
  if (delta < -0.3) return "worsening";
  return "stable";
}

function computeTopConcerns(windows: WindowAnalysis[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const w of windows) {
    for (const concern of w.dominantConcerns ?? []) {
      const key = concern.toLowerCase().trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, limit).map(([k]) => k);
}

export async function loadRecentWindowSummary(days: number): Promise<WindowSummary> {
  const windows = await loadWindowAnalysesForLastDays(days);
  if (windows.length === 0) {
    return {
      windows: [],
      summary: {
        moodTrend: "unknown",
        avgMood: "mixed",
        avgStress: 0,
        avgEnergy: 0,
        topConcerns: [],
      },
    };
  }

  const avgStress = windows.reduce((sum, w) => sum + (w.stressLevel ?? 0), 0) / windows.length;
  const avgEnergy = windows.reduce((sum, w) => sum + (w.energyLevel ?? 0), 0) / windows.length;
  const avgMoodScore = windows.reduce((sum, w) => sum + mapMoodToScore(w.mood), 0) / windows.length;

  return {
    windows,
    summary: {
      moodTrend: computeMoodTrend(windows),
      avgMood: mapScoreToMood(avgMoodScore),
      avgStress,
      avgEnergy,
      topConcerns: computeTopConcerns(windows),
    },
  };
}

export async function getRecentWindows(opts: { hours?: number; limit?: number } = {}): Promise<WindowAnalysis[]> {
  const hours = opts.hours ?? 72;
  const limit = opts.limit ?? 30;
  const windows = await loadRecentWindowAnalyses(hours);
  const sorted = [...windows].sort((a, b) => b.toTs - a.toTs);
  return sorted.slice(0, limit);
}

export type { AnalyzeWindowParams, WindowSummary };
