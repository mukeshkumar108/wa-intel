import { DailyStateSnapshot, MessageRecord } from "../types.js";
import {
  saveDailyStateSnapshot,
  getDailyStateSnapshotByDate,
  getDailyStateSnapshots,
} from "../stateDailyStore.js";
import { fetchRecentMessages } from "../whatsappClient.js";
import { buildDailyStatePrompt } from "../prompts.js";
import { callLLM } from "../llm.js";
import { getUserTimezoneOffsetHours } from "../config.js";

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function parseDateToWindow(date: string): { fromTs: number; toTs: number } {
  const parts = date.split("-");
  if (parts.length !== 3) {
    const now = Date.now();
    return { fromTs: startOfDay(now), toTs: endOfDay(now) };
  }
  const [yearStr, monthStr, dayStr] = parts;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const d = new Date();
  d.setFullYear(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  const fromTs = d.getTime();
  d.setHours(23, 59, 59, 999);
  const toTs = d.getTime();
  return { fromTs, toTs };
}

function clampNumber(value: any, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

function computeContactStats(messages: MessageRecord[]) {
  const statsByChat = new Map<
    string,
    { chatId: string; displayName: string; messageCount: number; fromMeCount: number; fromThemCount: number }
  >();
  for (const m of messages) {
    const key = m.chatId;
    let stats = statsByChat.get(key);
    if (!stats) {
      stats = {
        chatId: m.chatId,
        displayName: m.displayName || m.chatId,
        messageCount: 0,
        fromMeCount: 0,
        fromThemCount: 0,
      };
      statsByChat.set(key, stats);
    }
    stats.messageCount += 1;
    if (m.fromMe) stats.fromMeCount += 1;
    else stats.fromThemCount += 1;
    if (m.displayName && stats.displayName === stats.chatId) {
      stats.displayName = m.displayName;
    }
  }
  const all = Array.from(statsByChat.values());
  all.sort((a, b) => b.messageCount - a.messageCount);
  return all;
}

function computeDailyInteractionStats(messages: MessageRecord[]) {
  const tzOffsetHours = getUserTimezoneOffsetHours();
  const topContacts = computeContactStats(messages).slice(0, 5);
  const lateNightMessages: MessageRecord[] = [];
  const earlyMorningMessages: MessageRecord[] = [];
  for (const m of messages) {
    const d = new Date(m.ts);
    const hour = (d.getUTCHours() + tzOffsetHours + 24) % 24;
    if (hour >= 23 || hour < 3) lateNightMessages.push(m);
    if (hour >= 5 && hour < 10) earlyMorningMessages.push(m);
  }
  const lateNightContacts = lateNightMessages.length ? computeContactStats(lateNightMessages).slice(0, 5) : [];
  const earlyMorningContacts = earlyMorningMessages.length
    ? computeContactStats(earlyMorningMessages).slice(0, 5)
    : [];
  return {
    topContacts,
    lateNightContacts,
    earlyMorningContacts,
    lateNightPrimaryContact: lateNightContacts[0],
    earlyMorningPrimaryContact: earlyMorningContacts[0],
  };
}

export async function generateDailyState(
  date: string,
  opts?: { force?: boolean }
): Promise<DailyStateSnapshot> {
  const force = !!opts?.force;
  if (!force) {
    const existing = await getDailyStateSnapshotByDate(date);
    if (existing) return existing;
  }

  const { fromTs, toTs } = parseDateToWindow(date);
  const all = await fetchRecentMessages(2000);
  const messages = all.filter((m) => m.ts >= fromTs && m.ts <= toTs);
  const interaction = computeDailyInteractionStats(messages);

  if (messages.length === 0) {
    const emptySnapshot: DailyStateSnapshot = {
      date,
      fromTs,
      toTs,
      mood: "unknown",
      energyLevel: 0,
      stressLevel: 0,
      dominantConcerns: [],
      selfTalkTone: [],
      copingPatterns: [],
      underlyingThemes: [],
      notableMoments: [],
      topContacts: interaction.topContacts,
      lateNightContacts: interaction.lateNightContacts,
      earlyMorningContacts: interaction.earlyMorningContacts,
      lateNightPrimaryContact: interaction.lateNightPrimaryContact,
      earlyMorningPrimaryContact: interaction.earlyMorningPrimaryContact,
    };
    await saveDailyStateSnapshot(emptySnapshot);
    return emptySnapshot;
  }

  const prompt = buildDailyStatePrompt({ date, messages });
  const snapshot = await callLLM<DailyStateSnapshot>("state", prompt);
  const earliest = messages.reduce((min, m) => Math.min(min, m.ts), messages[0].ts);
  const latest = messages.reduce((max, m) => Math.max(max, m.ts), messages[0].ts);

  const finalized: DailyStateSnapshot = {
    ...snapshot,
    date,
    fromTs: earliest,
    toTs: latest,
    mood: snapshot?.mood ?? "unknown",
    energyLevel: clampNumber(snapshot?.energyLevel, 0, 100, 0),
    stressLevel: clampNumber(snapshot?.stressLevel, 0, 100, 0),
    dominantConcerns: Array.isArray(snapshot?.dominantConcerns)
      ? snapshot.dominantConcerns.filter((s) => typeof s === "string")
      : [],
    selfTalkTone: Array.isArray(snapshot?.selfTalkTone)
      ? snapshot.selfTalkTone.filter((s) => typeof s === "string")
      : [],
    copingPatterns: Array.isArray(snapshot?.copingPatterns)
      ? snapshot.copingPatterns.filter((s) => typeof s === "string")
      : [],
    underlyingThemes: Array.isArray(snapshot?.underlyingThemes)
      ? snapshot.underlyingThemes.filter((s) => typeof s === "string")
      : undefined,
    notableMoments: Array.isArray(snapshot?.notableMoments)
      ? snapshot.notableMoments
          .filter((m) => m && typeof m.ts === "number" && typeof m.summary === "string")
          .map((m) => ({ ts: m.ts, summary: m.summary }))
          .slice(0, 5)
      : [],
    topContacts: interaction.topContacts,
    lateNightContacts: interaction.lateNightContacts,
    earlyMorningContacts: interaction.earlyMorningContacts,
    lateNightPrimaryContact: interaction.lateNightPrimaryContact,
    earlyMorningPrimaryContact: interaction.earlyMorningPrimaryContact,
  };

  await saveDailyStateSnapshot(finalized);
  return finalized;
}

export async function getRecentStateSnapshots(days: number) {
  return getDailyStateSnapshots(days);
}
