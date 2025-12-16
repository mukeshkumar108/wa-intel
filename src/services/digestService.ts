import { DailyDigestSnapshot } from "../types.js";
import { getDailyDigestSnapshot, saveDailyDigestSnapshot } from "../digestStore.js";
import { fetchMessagesSince, fetchRecentMessages } from "../whatsappClient.js";
import { callLLM } from "../llm.js";
import { buildSummaryPrompt, toSummaryMessages, ConversationSummary } from "../prompts.js";
import { getActiveOpenLoops } from "../openLoopsStore.js";

export async function generateDailyDigest(
  date: string,
  opts?: { force?: boolean }
): Promise<DailyDigestSnapshot> {
  const force = !!opts?.force;
  if (!force) {
    const existing = await getDailyDigestSnapshot(date);
    if (existing) return existing;
  }

  // compute window for that date (24h)
  const d = new Date(date + "T00:00:00Z");
  const fromTs = d.getTime();
  const toTs = fromTs + 24 * 60 * 60 * 1000 - 1;

  const maxMessages = 2000;
  let rawMessages =
    (await fetchMessagesSince(fromTs, maxMessages).catch(() => fetchRecentMessages(maxMessages))) ??
    [];
  rawMessages = rawMessages.filter((m) => m.ts >= fromTs && m.ts <= toTs);
  rawMessages.sort((a, b) => a.ts - b.ts);
  if (rawMessages.length > maxMessages) {
    rawMessages = rawMessages.slice(rawMessages.length - maxMessages);
  }

  const messages = toSummaryMessages(rawMessages);
  messages.sort((a, b) => a.ts - b.ts);

  let summary: ConversationSummary;
  if (messages.length === 0) {
    summary = {
      narrativeSummary: "No recent messages.",
      keyPeople: [],
      keyTopics: [],
      openLoops: [],
    };
  } else {
    const prompt = buildSummaryPrompt(messages);
    summary = await callLLM<ConversationSummary>("digest", prompt);
  }

  const openLoops = await getActiveOpenLoops();

  const snapshot: DailyDigestSnapshot = {
    date,
    summary,
    openLoops,
    generatedAt: Date.now(),
    meta: {
      fromTs,
      toTs,
      messageCount: messages.length,
    },
  };

  await saveDailyDigestSnapshot(date, snapshot);
  return snapshot;
}

export async function getDailyDigest(date: string) {
  return getDailyDigestSnapshot(date);
}
