import fs from "fs";
import path from "path";
import { fetchActiveChats, fetchChatMessagesBefore, fetchRecentMessages } from "../whatsappClient.js";
import type { MessageRecord } from "../types.js";

const OUT_DIR = path.join(process.cwd(), "out", "intel");
const HISTORY_PATH = path.join(OUT_DIR, "metrics_timeofday.jsonl");
const LATEST_PATH = path.join(OUT_DIR, "metrics_timeofday_latest.json");
const DEFAULT_TZ = process.env.METRICS_TZ || "Europe/London";

type BucketCounts = {
  morning: number;
  day: number;
  evening: number;
  night: number;
};

export type ChatTimeOfDayMetrics = {
  chatId: string;
  displayName: string;
  sampleSize: number;
  oldestTs: number | null;
  newestTs: number | null;
  counts: BucketCounts;
  pct: BucketCounts;
  nightOwl_00_06_fromMe: number;
  morning_06_10_fromMe: number;
};

export type TimeOfDaySnapshot = {
  date: string;
  generatedAt: number;
  params: { limitChats: number; limitPerChat: number; includeGroups: boolean };
  results: ChatTimeOfDayMetrics[];
  totalChats?: number;
  activeChats?: number;
  omittedInactiveChats?: number;
  activeCriteria?: { activeDays?: number; minMsgs?: number; activeOnly?: boolean };
};

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function getHour(ts: number): number {
  const formatter = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: DEFAULT_TZ });
  return Number(formatter.format(new Date(ts)));
}

function bucketHour(hour: number): keyof BucketCounts {
  if (hour >= 6 && hour <= 11) return "morning";
  if (hour >= 12 && hour <= 16) return "day";
  if (hour >= 17 && hour <= 22) return "evening";
  return "night"; // 23, 0–5
}

function computeChatMetrics(chatId: string, displayName: string, messages: MessageRecord[]): ChatTimeOfDayMetrics {
  const counts: BucketCounts = { morning: 0, day: 0, evening: 0, night: 0 };
  let nightOwl = 0;
  let morningFromMe = 0;
  let oldestTs: number | null = null;
  let newestTs: number | null = null;

  for (const msg of messages) {
    const h = getHour(msg.ts);
    counts[bucketHour(h)] += 1;
    if (msg.fromMe && h >= 0 && h <= 5) nightOwl++;
    if (msg.fromMe && h >= 6 && h <= 10) morningFromMe++;
    oldestTs = oldestTs === null ? msg.ts : Math.min(oldestTs, msg.ts);
    newestTs = newestTs === null ? msg.ts : Math.max(newestTs, msg.ts);
  }

  const sampleSize = messages.length;
  const pct: BucketCounts = {
    morning: sampleSize ? counts.morning / sampleSize : 0,
    day: sampleSize ? counts.day / sampleSize : 0,
    evening: sampleSize ? counts.evening / sampleSize : 0,
    night: sampleSize ? counts.night / sampleSize : 0,
  };

  return {
    chatId,
    displayName,
    sampleSize,
    oldestTs,
    newestTs,
    counts,
    pct,
    nightOwl_00_06_fromMe: nightOwl,
    morning_06_10_fromMe: morningFromMe,
  };
}

export async function runTimeOfDayMetrics(opts: {
  limitChats: number;
  limitPerChat: number;
  includeGroups: boolean;
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
    activeOnly,
    activeDays = 30,
    recentLimit = 4000,
    maxChats = 50,
    minMsgs = 0,
  } = opts;
  let chatsToProcess: { chatId: string; displayName?: string | null; isGroup?: boolean }[] = [];

  if (activeOnly) {
    const cutoff = Date.now() - activeDays * 24 * 60 * 60 * 1000;
    const recent = await fetchRecentMessages(recentLimit);
    const seen = new Set<string>();
    const picked: { chatId: string; displayName?: string | null; isGroup?: boolean }[] = [];
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

  const results: ChatTimeOfDayMetrics[] = [];
  for (const chat of chatsToProcess) {
    const chatId = chat.chatId;
    const displayName = chat.displayName ?? chatId;
    const { messages } = await fetchChatMessagesBefore(chatId, 0, limitPerChat).catch(() => ({ messages: [] as MessageRecord[] }));
    const metrics = computeChatMetrics(chatId, displayName, messages);
    if (minMsgs > 0) {
      const total =
        Number(metrics?.counts?.morning ?? 0) +
        Number(metrics?.counts?.day ?? 0) +
        Number(metrics?.counts?.evening ?? 0) +
        Number(metrics?.counts?.night ?? 0);
      if (total < minMsgs) continue;
    }
    results.push(metrics);
  }

  const snapshot: TimeOfDaySnapshot = {
    date: new Date().toISOString().slice(0, 10),
    generatedAt: Date.now(),
    params: { limitChats, limitPerChat, includeGroups },
    results,
    totalChats: results.length,
    activeChats: results.filter((r) => {
      const total =
        Number(r?.counts?.morning ?? 0) +
        Number(r?.counts?.day ?? 0) +
        Number(r?.counts?.evening ?? 0) +
        Number(r?.counts?.night ?? 0);
      return total > 0;
    }).length,
    omittedInactiveChats: Math.max(
      0,
      results.length -
        results.filter((r) => {
          const total =
            Number(r?.counts?.morning ?? 0) +
            Number(r?.counts?.day ?? 0) +
        Number(r?.counts?.evening ?? 0) +
        Number(r?.counts?.night ?? 0);
      return total > 0;
    }).length
    ),
    activeCriteria: { activeDays, minMsgs, activeOnly: !!activeOnly },
  };

  ensureOutDir();
  fs.appendFileSync(HISTORY_PATH, JSON.stringify(snapshot) + "\n");
  fs.writeFileSync(LATEST_PATH, JSON.stringify(snapshot, null, 2));

  return snapshot;
}

export function readLatestTimeOfDayMetrics(): TimeOfDaySnapshot | null {
  try {
    const raw = fs.readFileSync(LATEST_PATH, "utf8");
    return JSON.parse(raw) as TimeOfDaySnapshot;
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[metrics] read latest failed", err);
    return null;
  }
}

export function readTimeOfDayHistory(days: number): TimeOfDaySnapshot[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results: TimeOfDaySnapshot[] = [];
  try {
    const raw = fs.readFileSync(HISTORY_PATH, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TimeOfDaySnapshot;
        if (!entry.generatedAt || entry.generatedAt < cutoff) continue;
        results.push(entry);
      } catch (err) {
        console.error("[metrics] parse history line failed", err);
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[metrics] read history failed", err);
  }
  return results;
}
