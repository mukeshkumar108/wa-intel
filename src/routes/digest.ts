import { Router } from "express";
import { fetchMessagesSince, fetchRecentMessages } from "../whatsappClient.js";
import { toSummaryMessages, ConversationSummary } from "../prompts.js";
import { getCuratedPlateOpenLoops } from "../services/openLoopsV2Service.js";

export const digestRouter = Router();

function buildPlateNarrative(existing: string | undefined, loops: any[]): string {
  if (existing && existing.trim().length > 0) return existing;
  if (!loops || loops.length === 0) return "No urgent items in the last day.";
  const parts = loops.slice(0, 3).map((l) => {
    const who = l.displayName || l.chatId;
    return `${l.summary} (${who})`;
  });
  return parts.join("; ");
}

function deriveTopics(loops: any[]): string[] {
  const topics = new Set<string>();
  for (const l of loops.slice(0, 5)) {
    const summary = (l.summary ?? "").toLowerCase();
    summary
      .split(/\W+/)
      .filter((w: string) => w.length > 4)
      .slice(0, 3)
      .forEach((w: string) => topics.add(w));
  }
  return Array.from(topics).slice(0, 8);
}

export async function generateTodayDigest() {
  const nowTs = Date.now();
  const sinceTs = nowTs - 24 * 60 * 60 * 1000;
  const maxMessages = 2000;

  let rawMessages =
    (await fetchMessagesSince(sinceTs, maxMessages).catch(() => fetchRecentMessages(maxMessages))) ??
    [];

  rawMessages = rawMessages.filter((m) => m.ts >= sinceTs);
  rawMessages.sort((a, b) => a.ts - b.ts);
  if (rawMessages.length > maxMessages) {
    rawMessages = rawMessages.slice(rawMessages.length - maxMessages);
  }

  const messages = toSummaryMessages(rawMessages);
  messages.sort((a, b) => a.ts - b.ts);

  const plate = await getCuratedPlateOpenLoops(7);
  const openLoopsToday = plate.openLoops.filter((ol) => ol.lastSeenTs >= sinceTs && ol.lastSeenTs <= nowTs);

  const topLoops = openLoopsToday.slice(0, 3);
  const narrative = buildPlateNarrative(plate.narrativeSummary, topLoops);
  const keyPeople = Array.from(
    new Set(openLoopsToday.map((l) => l.displayName).filter((n): n is string => !!n && n !== "unknown"))
  );
  const keyTopics = deriveTopics(openLoopsToday);

  const summary: ConversationSummary = {
    narrativeSummary: narrative,
    keyPeople,
    keyTopics,
    openLoops: openLoopsToday as any,
  };

  return {
    summary: {
      ...summary,
    },
    openLoops: openLoopsToday,
    activeOpenLoops: plate.openLoops,
    generatedAt: nowTs,
    meta: {
      fromTs: sinceTs,
      toTs: nowTs,
      messageCount: messages.length,
    },
  };
}

// "Today" digest: last 24 hours + active open loops.
digestRouter.get("/digest/today", async (_req, res) => {
  try {
    const digest = await generateTodayDigest();
    res.json(digest);
  } catch (err: any) {
    console.error("Error in /digest/today:", err?.message ?? err);
    res.status(500).json({ error: "Failed to generate digest" });
  }
});
