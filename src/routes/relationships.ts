import { Router } from "express";
import { callLLM, getModelName } from "../llm.js";
import {
  buildRelationshipPrompt,
  toSummaryMessages,
  SummaryRequestMessage,
} from "../prompts.js";
import { fetchChatMessages } from "../whatsappClient.js";
import { MessageRecord, RelationshipMetrics, RelationshipModel, RelationshipSummary } from "../types.js";
import { getRecentOneToOneChats, PersonSummary } from "./people.js";
import { getRelationshipSnapshotsForChat } from "../relationshipSnapshotsStore.js";
import { getActiveOpenLoopsFromWindows } from "../services/openLoopsV2Service.js";
import { buildRelationshipRollup } from "../services/relationshipRollupService.js";
import { generateRelationshipSnapshot } from "../services/relationshipService.js";

export const relationshipsRouter = Router();

const DEFAULT_LIMIT = 200;
const MIN_LIMIT = 50;
const MAX_LIMIT = 500;
const OVERVIEW_DEFAULT_DAYS = 30;
const OVERVIEW_DEFAULT_LIMIT = 20;
const OVERVIEW_MIN_DAYS = 1;
const OVERVIEW_MAX_DAYS = 365;
const OVERVIEW_MIN_LIMIT = 1;
const OVERVIEW_MAX_LIMIT = 50;
const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MIN_LIMIT = 1;
const HISTORY_MAX_LIMIT = 100;
const SNAPSHOT_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function inferDisplayName(messages: SummaryRequestMessage[]): string | null {
  const counts = new Map<string, number>();

  for (const msg of messages) {
    if (msg.fromMe) continue;
    const name = msg.displayName?.trim();
    if (!name) continue;

    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  let best: { name: string; count: number } | null = null;
  for (const [name, count] of counts.entries()) {
    if (!best || count > best.count) {
      best = { name, count };
    }
  }

  return best?.name ?? null;
}

export function computeRelationshipMetrics(messages: MessageRecord[], nowTs: number): RelationshipMetrics {
  const DAY_MS = 1000 * 60 * 60 * 24;
  const last7Boundary = nowTs - 7 * DAY_MS;
  const last30Boundary = nowTs - 30 * DAY_MS;

  const totalMessages = messages.length;
  const fromMeCount = messages.reduce((count, msg) => count + (msg.fromMe ? 1 : 0), 0);
  const fromThemCount = totalMessages - fromMeCount;

  let last7DaysCount = 0;
  let last30DaysCount = 0;
  let latestTs: number | null = null;

  for (const msg of messages) {
    if (msg.ts >= last7Boundary) last7DaysCount += 1;
    if (msg.ts >= last30Boundary) last30DaysCount += 1;
    if (latestTs === null || msg.ts > latestTs) {
      latestTs = msg.ts;
    }
  }

  const sorted = [...messages].sort((a, b) => a.ts - b.ts);
  const meResponseTimes: number[] = [];
  const themResponseTimes: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    if (prev.fromMe === curr.fromMe) continue;

    const delta = curr.ts - prev.ts;
    if (delta < 0) continue;

    if (!prev.fromMe && curr.fromMe) {
      meResponseTimes.push(delta);
    } else if (prev.fromMe && !curr.fromMe) {
      themResponseTimes.push(delta);
    }
  }

  const average = (values: number[]): number | undefined => {
    if (values.length === 0) return undefined;
    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
  };

  const activityByTimeOfDay: RelationshipMetrics["activityByTimeOfDay"] = {
    morning: 0,
    afternoon: 0,
    evening: 0,
    night: 0,
  };

  const mediaStats: RelationshipMetrics["mediaStats"] = {
    textCount: 0,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
    stickerCount: 0,
  };

  for (const msg of messages) {
    const hour = new Date(msg.ts).getHours();
    if (hour >= 5 && hour <= 11) {
      activityByTimeOfDay.morning += 1;
    } else if (hour >= 12 && hour <= 17) {
      activityByTimeOfDay.afternoon += 1;
    } else if (hour >= 18 && hour <= 22) {
      activityByTimeOfDay.evening += 1;
    } else {
      activityByTimeOfDay.night += 1;
    }

    switch (msg.type) {
      case "chat":
        mediaStats.textCount += 1;
        break;
      case "image":
        mediaStats.imageCount += 1;
        break;
      case "video":
        mediaStats.videoCount += 1;
        break;
      case "audio":
      case "ptt":
        mediaStats.audioCount += 1;
        break;
      case "sticker":
        mediaStats.stickerCount += 1;
        break;
      default:
        break;
    }
  }

  const daysSinceLastMessage =
    latestTs === null ? null : Math.floor((nowTs - latestTs) / DAY_MS);

  return {
    totalMessages,
    fromMeCount,
    fromThemCount,
    last7DaysCount,
    last30DaysCount,
    avgMessagesPerDay30d: last30DaysCount / 30,
    daysSinceLastMessage,
    avgResponseTimeMsMe: average(meResponseTimes),
    avgResponseTimeMsThem: average(themResponseTimes),
    activityByTimeOfDay,
    mediaStats,
  };
}

const ENERGETIC_POLARITY: RelationshipModel["energeticPolarity"][] = [
  "balanced",
  "me_chasing",
  "them_chasing",
  "unclear",
];
const EMOTIONAL_VALENCE_OVERALL: RelationshipModel["emotionalValence"]["overall"][] = [
  "mostly_positive",
  "mixed",
  "mostly_negative",
  "unclear",
];
const EMOTIONAL_VALENCE_TREND: RelationshipModel["emotionalValence"]["recentTrend"][] = [
  "improving",
  "worsening",
  "stable",
  "unclear",
];
const INITIATION_PATTERN: RelationshipModel["communicationDynamics"]["initiationPattern"][] = [
  "balanced",
  "mostly_me",
  "mostly_them",
  "unclear",
];
const CONSISTENCY: RelationshipModel["communicationDynamics"]["consistency"][] = [
  "very_consistent",
  "consistent",
  "sporadic",
  "on_off",
  "unclear",
];
const RESPONSE_TIME: RelationshipModel["communicationDynamics"]["typicalResponseTime"][] = [
  "very_fast",
  "fast",
  "moderate",
  "slow",
  "very_slow",
  "unclear",
];
const PERCEIVED_BALANCE: RelationshipModel["powerBalance"]["perceivedBalance"][] = [
  "balanced",
  "me_leading",
  "them_leading",
  "unclear",
];
const EMOTIONAL_DEPENDENCY: RelationshipModel["powerBalance"]["emotionalDependency"][] = [
  "balanced",
  "i_dependent",
  "they_dependent",
  "mutual_high",
  "unclear",
];
const CONFLICT_FREQUENCY: RelationshipModel["volatility"]["conflictFrequency"][] = [
  "rare",
  "sometimes",
  "frequent",
  "unclear",
];
const EMOTIONAL_SWINGS: RelationshipModel["volatility"]["emotionalSwings"][] = [
  "low",
  "medium",
  "high",
  "unclear",
];
const GROWTH_IMPACT: RelationshipModel["valuesAlignment"]["growthImpact"][] = [
  "strong_positive",
  "positive",
  "neutral",
  "negative",
  "harmful",
  "unclear",
];
const TRAJECTORY: RelationshipModel["trajectory"]["longTermTrajectory"][] = [
  "expanding",
  "deepening",
  "stable",
  "drifting",
  "deteriorating",
  "cyclical",
  "unclear",
];

function normalizeEnum<T extends string>(value: any, allowed: readonly T[], fallback: T): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

function clampScore(value: any): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(Math.max(num, 0), 100);
}

function normalizeStringArray(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry: string) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeOptionalString(value: any): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeToThirdPerson(text: string): string {
  let result = text;
  const replacements: Array<[RegExp, string]> = [
    [/\b[Ii]\b/g, "the user"],
    [/\bme\b/gi, "the user"],
    [/\bmyself\b/gi, "the user"],
    [/\bmy\b/gi, "the user's"],
    [/\bmine\b/gi, "the user's"],
    [/\bwe\b/gi, "the user and the other party"],
    [/\bus\b/gi, "the user and the other party"],
    [/\bour\b/gi, "the user and the other party's"],
    [/\bours\b/gi, "the user and the other party's"],
  ];

  for (const [regex, replacement] of replacements) {
    result = result.replace(regex, replacement);
  }

  return result.trim();
}

function sanitizeStringArrayThirdPerson(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return values;
  const sanitized = values
    .map((v) => sanitizeToThirdPerson(v))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return sanitized.length > 0 ? sanitized : undefined;
}

export function normalizeRelationshipModel(raw: any): RelationshipModel | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const hasAny =
    raw.energeticPolarity !== undefined ||
    raw.emotionalValence !== undefined ||
    raw.intimacy !== undefined ||
    raw.attraction !== undefined ||
    raw.communicationDynamics !== undefined ||
    raw.powerBalance !== undefined ||
    raw.volatility !== undefined ||
    raw.behaviouralLoops !== undefined ||
    raw.riskBehaviours !== undefined ||
    raw.valuesAlignment !== undefined ||
    raw.trajectory !== undefined ||
    raw.shadowPatterns !== undefined;

  if (!hasAny) return undefined;

  const model: RelationshipModel = {
    energeticPolarity: normalizeEnum(raw.energeticPolarity, ENERGETIC_POLARITY, "unclear"),
    emotionalValence: {
      overall: normalizeEnum(
        raw.emotionalValence?.overall,
        EMOTIONAL_VALENCE_OVERALL,
        "unclear"
      ),
      recentTrend: normalizeEnum(
        raw.emotionalValence?.recentTrend,
        EMOTIONAL_VALENCE_TREND,
        "unclear"
      ),
    },
    intimacy: {
      emotional: clampScore(raw.intimacy?.emotional),
      vulnerability: clampScore(raw.intimacy?.vulnerability),
      physicalOrSexual: clampScore(raw.intimacy?.physicalOrSexual),
    },
    attraction: {
      myAttraction: clampScore(raw.attraction?.myAttraction),
      theirAttraction: clampScore(raw.attraction?.theirAttraction),
      flirtationLevel: clampScore(raw.attraction?.flirtationLevel),
    },
    communicationDynamics: {
      initiationPattern: normalizeEnum(
        raw.communicationDynamics?.initiationPattern,
        INITIATION_PATTERN,
        "unclear"
      ),
      consistency: normalizeEnum(raw.communicationDynamics?.consistency, CONSISTENCY, "unclear"),
      typicalResponseTime: normalizeEnum(
        raw.communicationDynamics?.typicalResponseTime,
        RESPONSE_TIME,
        "unclear"
      ),
      timeOfDayPattern: normalizeOptionalString(raw.communicationDynamics?.timeOfDayPattern),
    },
    powerBalance: {
      perceivedBalance: normalizeEnum(
        raw.powerBalance?.perceivedBalance,
        PERCEIVED_BALANCE,
        "unclear"
      ),
      emotionalDependency: normalizeEnum(
        raw.powerBalance?.emotionalDependency,
        EMOTIONAL_DEPENDENCY,
        "unclear"
      ),
    },
    volatility: {
      stabilityScore: clampScore(raw.volatility?.stabilityScore),
      conflictFrequency: normalizeEnum(
        raw.volatility?.conflictFrequency,
        CONFLICT_FREQUENCY,
        "unclear"
      ),
      emotionalSwings: normalizeEnum(
        raw.volatility?.emotionalSwings,
        EMOTIONAL_SWINGS,
        "unclear"
      ),
    },
    behaviouralLoops: {
      patterns: normalizeStringArray(raw.behaviouralLoops?.patterns),
    },
    riskBehaviours: {
      temptationScore: clampScore(raw.riskBehaviours?.temptationScore),
      selfSabotageScore: clampScore(raw.riskBehaviours?.selfSabotageScore),
      boundarySlipScore: clampScore(raw.riskBehaviours?.boundarySlipScore),
      notes: (() => {
        const list = normalizeStringArray(raw.riskBehaviours?.notes);
        return list.length > 0 ? list : undefined;
      })(),
    },
    valuesAlignment: {
      alignmentScore: clampScore(raw.valuesAlignment?.alignmentScore),
      growthImpact: normalizeEnum(raw.valuesAlignment?.growthImpact, GROWTH_IMPACT, "unclear"),
      comments: (() => {
        const list = normalizeStringArray(raw.valuesAlignment?.comments);
        return list.length > 0 ? list : undefined;
      })(),
    },
    trajectory: {
      longTermTrajectory: normalizeEnum(raw.trajectory?.longTermTrajectory, TRAJECTORY, "unclear"),
      recentKeyShifts: (() => {
        const list = normalizeStringArray(raw.trajectory?.recentKeyShifts);
        return list.length > 0 ? list : undefined;
      })(),
    },
    shadowPatterns: normalizeStringArray(raw.shadowPatterns),
  };

  model.behaviouralLoops.patterns = sanitizeStringArrayThirdPerson(
    model.behaviouralLoops.patterns
  ) ?? [];
  model.riskBehaviours.notes = sanitizeStringArrayThirdPerson(model.riskBehaviours.notes);
  model.valuesAlignment.comments = sanitizeStringArrayThirdPerson(model.valuesAlignment.comments);
  model.trajectory.recentKeyShifts = sanitizeStringArrayThirdPerson(
    model.trajectory.recentKeyShifts
  );
  model.shadowPatterns = sanitizeStringArrayThirdPerson(model.shadowPatterns) ?? [];
  model.communicationDynamics.timeOfDayPattern = model.communicationDynamics.timeOfDayPattern
    ? sanitizeToThirdPerson(model.communicationDynamics.timeOfDayPattern)
    : undefined;

  return model;
}

function parseNumberParam(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

async function countOpenLoopsByChatId(): Promise<Map<string, number>> {
  const activeLoops = await getActiveOpenLoopsFromWindows(30);
  const counts = new Map<string, number>();

  for (const loop of activeLoops) {
    counts.set(loop.chatId, (counts.get(loop.chatId) ?? 0) + 1);
  }

  return counts;
}

function attachOpenLoopCounts(
  people: PersonSummary[],
  counts: Map<string, number>
): Array<PersonSummary & { openLoopCount: number }> {
  return people.map((person) => ({
    ...person,
    openLoopCount: counts.get(person.chatId) ?? 0,
  }));
}

// GET /relationships/overview?days=30&limit=20
relationshipsRouter.get("/relationships/overview", async (req, res) => {
  try {
    const days = parseNumberParam(
      req.query.days as string | undefined,
      OVERVIEW_DEFAULT_DAYS,
      OVERVIEW_MIN_DAYS,
      OVERVIEW_MAX_DAYS
    );
    const limit = parseNumberParam(
      req.query.limit as string | undefined,
      OVERVIEW_DEFAULT_LIMIT,
      OVERVIEW_MIN_LIMIT,
      OVERVIEW_MAX_LIMIT
    );

    const { people, totalFound } = await getRecentOneToOneChats(days, limit);
    const openLoopCounts = await countOpenLoopsByChatId();
    const relationships = attachOpenLoopCounts(people, openLoopCounts);

    res.json({
      relationships,
      meta: {
        days,
        limit,
        totalFound,
      },
    });
  } catch (err: any) {
    console.error("Error in /relationships/overview:", err?.message ?? err);
    res.status(500).json({ error: "Failed to generate relationships overview" });
  }
});

// GET /relationships/history/:chatId?limit=<n>
relationshipsRouter.get("/relationships/history/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const limit = parseNumberParam(
      req.query.limit as string | undefined,
      HISTORY_DEFAULT_LIMIT,
      HISTORY_MIN_LIMIT,
      HISTORY_MAX_LIMIT
    );

    const snapshots = await getRelationshipSnapshotsForChat(chatId, limit);

    res.json({ chatId, snapshots });
  } catch (err: any) {
    console.error("Error in /relationships/history:", err?.message ?? err);
    res.status(500).json({ error: "Failed to fetch relationship history" });
  }
});

export async function generateRelationshipSummary(
  chatId: string,
  limit: number
): Promise<RelationshipSummary> {
  const rawMessages = await fetchChatMessages(chatId, limit);
  rawMessages.sort((a, b) => a.ts - b.ts);
  const windowMessages = rawMessages.slice(-limit); // most recent up to limit, chronological

  const metrics = computeRelationshipMetrics(windowMessages, Date.now());
  const messages = toSummaryMessages(windowMessages);
  messages.sort((a, b) => a.ts - b.ts);

  if (messages.length === 0) {
    throw new Error("No messages found for this chat");
  }

  const inferredDisplayName = inferDisplayName(messages);
    const prompt = buildRelationshipPrompt(messages, chatId, inferredDisplayName);
    let summary: RelationshipSummary;
    try {
      summary = await callLLM<RelationshipSummary>("relationship", prompt);
    } catch (err) {
      console.error("[relationshipSummary] LLM call failed", {
        model: getModelName("relationship"),
        chatId,
        error: (err as Error)?.message ?? err,
      });
      throw err;
    }

  const firstMessageTs = summary.firstMessageTs ?? messages[0]?.ts ?? null;
  const lastMessageTs = summary.lastMessageTs ?? messages[messages.length - 1]?.ts ?? null;
  const normalizedModel = normalizeRelationshipModel(summary.model);

  const relationship: RelationshipSummary = {
    ...summary,
    chatId,
    displayName: summary.displayName ?? inferredDisplayName ?? null,
    firstMessageTs,
    lastMessageTs,
    metrics,
    model: normalizedModel,
  };

  return relationship;
}

// GET /relationships/chat/:chatId?limit=<n>
relationshipsRouter.get("/relationships/chat/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const limitParam = Number(req.query.limit);
    let limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT;
    limit = Math.min(Math.max(limit, MIN_LIMIT), MAX_LIMIT);

    const relationship = await generateRelationshipSummary(chatId, limit);

    // Ensure a base snapshot exists for future rollups (best-effort).
    try {
      await generateRelationshipSnapshot(chatId, { limit, force: false });
    } catch (err) {
      console.error("Failed to generate relationship snapshot (non-fatal):", err);
    }

    const rollup = await buildRelationshipRollup(chatId, 30);
    const response = {
      chatId,
      displayName: relationship.displayName ?? rollup.displayName ?? chatId,
      summary: relationship,
      model: rollup.model ?? relationship.model,
      rolling: rollup.rolling,
      baseSnapshot: rollup.baseSnapshot ?? relationship,
    };

    res.json({ relationship: response });
  } catch (err: any) {
    console.error("Error in /relationships/chat:", err?.message ?? err);
    res.status(500).json({ error: "Failed to generate relationship summary" });
  }
});
