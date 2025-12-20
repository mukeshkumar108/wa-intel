import fs from "fs";
import path from "path";
import { fetchActiveChats, fetchChatMessagesBefore, fetchRecentMessages } from "../whatsappClient.js";
import type { MessageRecord } from "../types.js";

const OUT_DIR = path.join(process.cwd(), "out", "intel");
const HISTORY_PATH = path.join(OUT_DIR, "metrics_daily.jsonl");
const LATEST_PATH = path.join(OUT_DIR, "metrics_daily_latest.json");
const DEFAULT_TZ = process.env.USER_TZ || "Europe/London";

type CoverageQuality = "EMPTY" | "THIN" | "OK";

type WindowMetrics = {
  windowDays: number;
  msgCountTotal: number;
  fromMeCount: number;
  fromOtherCount: number;
  balanceRatio: number;
  typeCounts: Record<string, number>;
  nightCountFromMe: number;
  burstCount: number;
  medianReplyTimeMeMs: number | null;
  medianReplyTimeOtherMs: number | null;
  coverage: {
    messagesInWindow: number;
    oldestTsInWindow: number | null;
    newestTsInWindow: number | null;
    coverageHours: number;
    coverageQuality: CoverageQuality;
  };
};

export type ChatDailyMetrics = {
  chatId: string;
  displayName: string;
  metricsByWindow: Record<string, WindowMetrics>;
};

export type DailyMetricsSnapshot = {
  generatedAt: number;
  tz: string;
  windows: number[];
  limitChats: number;
  limitPerChat: number;
  includeGroups: boolean;
  results: ChatDailyMetrics[];
  totalChats?: number;
  activeChats?: number;
  omittedInactiveChats?: number;
  activeCriteria?: { activeDays?: number; minMsgs?: number; activeOnly?: boolean };
};

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function getHourInTz(ts: number, tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: tz });
  return Number(formatter.format(new Date(ts)));
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function computeBurstCount(messages: MessageRecord[]): number {
  const sorted = [...messages].sort((a, b) => a.ts - b.ts);
  let bursts = 0;
  let runStart = 0;
  let runLen = 0;
  for (const m of sorted) {
    if (!m.fromMe) {
      if (runLen >= 3) bursts++;
      runStart = 0;
      runLen = 0;
      continue;
    }
    if (runLen === 0) {
      runStart = m.ts;
      runLen = 1;
      continue;
    }
    if (m.ts - runStart <= 60_000) {
      runLen++;
    } else {
      if (runLen >= 3) bursts++;
      runStart = m.ts;
      runLen = 1;
    }
  }
  if (runLen >= 3) bursts++;
  return bursts;
}

function computeReplyTimes(messages: MessageRecord[]): { meReplies: number[]; otherReplies: number[] } {
  const sorted = [...messages].sort((a, b) => a.ts - b.ts);
  const meReplies: number[] = [];
  const otherReplies: number[] = [];
  let lastOther: number | null = null;
  let lastMe: number | null = null;
  for (const m of sorted) {
    if (m.fromMe) {
      if (lastOther !== null) {
        meReplies.push(m.ts - lastOther);
      }
      lastMe = m.ts;
      lastOther = null;
    } else {
      if (lastMe !== null) {
        otherReplies.push(m.ts - lastMe);
      }
      lastOther = m.ts;
      lastMe = null;
    }
  }
  return { meReplies, otherReplies };
}

function coverageQuality(messages: MessageRecord[], oldest: number | null, newest: number | null): CoverageQuality {
  if (messages.length === 0) return "EMPTY";
  const hours = oldest !== null && newest !== null ? (newest - oldest) / 3_600_000 : 0;
  if (messages.length < 5 || hours < 6) return "THIN";
  return "OK";
}

function computeWindowMetrics(messages: MessageRecord[], windowDays: number, tz: string): WindowMetrics {
  const now = Date.now();
  const windowStart = now - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = messages.filter((m) => m.ts >= windowStart);
  const typeCounts: Record<string, number> = {
    chat: 0,
    image: 0,
    video: 0,
    ptt: 0,
    ptv: 0,
    sticker: 0,
    revoked: 0,
    document: 0,
    call_log: 0,
    other: 0,
  };
  let nightCountFromMe = 0;
  let fromMeCount = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const m of inWindow) {
    const type = m.type;
    if (type in typeCounts) typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    else typeCounts.other = (typeCounts.other ?? 0) + 1;
    if (m.fromMe) fromMeCount++;
    const hour = getHourInTz(m.ts, tz);
    if (m.fromMe && (hour === 23 || hour <= 5)) nightCountFromMe++;
    oldest = oldest === null ? m.ts : Math.min(oldest, m.ts);
    newest = newest === null ? m.ts : Math.max(newest, m.ts);
  }

  const msgCountTotal = inWindow.length;
  const fromOtherCount = msgCountTotal - fromMeCount;
  const balanceRatio = msgCountTotal ? fromMeCount / msgCountTotal : 0;
  const burstCount = computeBurstCount(inWindow);
  const { meReplies, otherReplies } = computeReplyTimes(inWindow);
  const coverageHours = oldest !== null && newest !== null ? (newest - oldest) / 3_600_000 : 0;

  return {
    windowDays,
    msgCountTotal,
    fromMeCount,
    fromOtherCount,
    balanceRatio,
    typeCounts,
    nightCountFromMe,
    burstCount,
    medianReplyTimeMeMs: median(meReplies),
    medianReplyTimeOtherMs: median(otherReplies),
    coverage: {
      messagesInWindow: msgCountTotal,
      oldestTsInWindow: oldest,
      newestTsInWindow: newest,
      coverageHours,
      coverageQuality: coverageQuality(inWindow, oldest, newest),
    },
  };
}

export async function runDailyMetrics(opts: {
  limitChats: number;
  limitPerChat: number;
  includeGroups: boolean;
  windows: number[];
  tz?: string;
  activeOnly?: boolean;
  activeDays?: number;
  recentLimit?: number;
  maxChats?: number;
  minMsgs?: number;
}) {
  const {
    limitChats,
    limitPerChat,
    includeGroups,
    windows,
    tz,
    activeOnly,
    activeDays = 30,
    recentLimit = 4000,
    maxChats = 50,
    minMsgs = 0,
  } = opts;
  const tzToUse = tz || DEFAULT_TZ;
  let chatsToProcess: { chatId: string; displayName?: string | null; isGroup?: boolean }[] = [];

  if (activeOnly) {
    const cutoff = Date.now() - activeDays * 24 * 60 * 60 * 1000;
    const recent = await fetchRecentMessages(recentLimit);
    const seen = new Set<string>();
    const picked: { chatId: string }[] = [];
    for (const m of recent) {
      if (m.ts < cutoff) continue;
      const isGroup = m.chatId.endsWith("@g.us");
      if (!includeGroups && isGroup) continue;
      if (m.chatId === "status@broadcast" || m.chatId.includes("@broadcast")) continue;
      if (seen.has(m.chatId)) continue;
      seen.add(m.chatId);
      picked.push({ chatId: m.chatId });
      if (picked.length >= maxChats) break;
    }
    chatsToProcess = picked;
  } else {
    const chats = await fetchActiveChats(limitChats, includeGroups);
    chatsToProcess = chats.filter((c) => {
      if (c.chatId === "status@broadcast") return false;
      if (!includeGroups && (c.isGroup || c.chatId.endsWith("@g.us"))) return false;
      return true;
    });
  }

  const results: ChatDailyMetrics[] = [];

  for (const chat of chatsToProcess) {
    const chatId = chat.chatId;
    const displayName = chat.displayName ?? chatId;
    const { messages } = await fetchChatMessagesBefore(chatId, 0, limitPerChat).catch(() => ({ messages: [] as MessageRecord[] }));
    const metricsByWindow: Record<string, WindowMetrics> = {};
    let hasMinMsgs = false;
    for (const w of windows) {
      const wm = computeWindowMetrics(messages, w, tzToUse);
      metricsByWindow[String(w)] = wm;
      if (minMsgs > 0 && wm.msgCountTotal >= minMsgs) hasMinMsgs = true;
    }
    if (minMsgs > 0 && !hasMinMsgs) continue;
    results.push({ chatId, displayName, metricsByWindow });
  }

  const snapshot: DailyMetricsSnapshot = {
    generatedAt: Date.now(),
    tz: tzToUse,
    windows,
    limitChats,
    limitPerChat,
    includeGroups,
    results,
    totalChats: results.length,
    activeChats: results.filter((r) => {
      const windowsMap = r.metricsByWindow ?? {};
      return Object.values(windowsMap).some((w: any) => {
        const msgCount = Number(w?.msgCountTotal ?? 0);
        const covMsgs = Number(w?.coverage?.messagesInWindow ?? 0);
        const covQual = w?.coverage?.coverageQuality;
        return msgCount > 0 || covMsgs > 0 || covQual !== "EMPTY";
      });
    }).length,
    omittedInactiveChats: Math.max(
      0,
      results.length -
        results.filter((r) => {
          const windowsMap = r.metricsByWindow ?? {};
          return Object.values(windowsMap).some((w: any) => {
            const msgCount = Number(w?.msgCountTotal ?? 0);
            const covMsgs = Number(w?.coverage?.messagesInWindow ?? 0);
            const covQual = w?.coverage?.coverageQuality;
            return msgCount > 0 || covMsgs > 0 || covQual !== "EMPTY";
          });
        }).length
    ),
    activeCriteria: { activeDays, minMsgs, activeOnly: !!activeOnly },
  };

  ensureOutDir();
  fs.appendFileSync(HISTORY_PATH, JSON.stringify(snapshot) + "\n");
  fs.writeFileSync(LATEST_PATH, JSON.stringify(snapshot, null, 2));

  return snapshot;
}

export async function runDailyMetricsForChat(chatId: string, opts: { windows: number[]; limitPerChat?: number; tz?: string }) {
  const windows = opts.windows ?? [1, 7, 30];
  const limitPerChat = opts.limitPerChat ?? 500;
  const tzToUse = opts.tz || DEFAULT_TZ;
  const { messages } = await fetchChatMessagesBefore(chatId, 0, limitPerChat).catch(() => ({ messages: [] as MessageRecord[] }));
  const metricsByWindow: Record<string, WindowMetrics> = {};
  for (const w of windows) {
    metricsByWindow[String(w)] = computeWindowMetrics(messages, w, tzToUse);
  }
  return { chatId, metricsByWindow, displayName: chatId };
}

export function readLatestDailyMetrics(): DailyMetricsSnapshot | null {
  try {
    const raw = fs.readFileSync(LATEST_PATH, "utf8");
    return JSON.parse(raw) as DailyMetricsSnapshot;
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[metrics] read latest daily failed", err);
    return null;
  }
}

export function readDailyMetricsHistory(days: number): DailyMetricsSnapshot[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries: DailyMetricsSnapshot[] = [];
  try {
    const raw = fs.readFileSync(HISTORY_PATH, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as DailyMetricsSnapshot;
        if (entry.generatedAt >= cutoff) entries.push(entry);
      } catch (err) {
        console.error("[metrics] parse daily history failed", err);
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[metrics] read daily history failed", err);
  }
  return entries;
}
