import { Router } from "express";
import { DailyStateSnapshot, MessageRecord } from "../types.js";
import { callLLM } from "../llm.js";
import { buildDailyStatePrompt } from "../prompts.js";
import { fetchRecentMessages } from "../whatsappClient.js";
import { getUserTimezoneOffsetHours } from "../config.js";
import { getRecentStateSnapshots } from "../services/stateService.js";

const stateRouter = Router();

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

function clampNumber(value: any, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

function summariseStateHistory(snapshots: DailyStateSnapshot[]) {
  if (snapshots.length === 0) {
    return {
      avgMood: "unknown",
      avgStress: 0,
      avgEnergy: 0,
      topConcerns: [],
      repeatedSelfTalk: [],
      trend: {
        mood: "unknown",
        stress: "unknown",
        energy: "unknown",
      },
    };
  }

  const moodWeights: Record<DailyStateSnapshot["mood"], number> = {
    mostly_positive: 2,
    mixed: 1,
    mostly_negative: -1,
    flat: 0,
    unknown: 0,
  };

  const moodByDay = snapshots.map((s) => moodWeights[s.mood] ?? 0);
  const avgMoodScore = moodByDay.reduce((a, b) => a + b, 0) / snapshots.length;
  const avgStress =
    snapshots.reduce((sum, s) => sum + (Number.isFinite(s.stressLevel) ? s.stressLevel : 0), 0) /
    snapshots.length;
  const avgEnergy =
    snapshots.reduce((sum, s) => sum + (Number.isFinite(s.energyLevel) ? s.energyLevel : 0), 0) /
    snapshots.length;

  const freq = (items: string[]): string[] => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (!item) continue;
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
      .slice(0, 5);
  };

  const topConcerns = freq(snapshots.flatMap((s) => s.dominantConcerns ?? []));
  const repeatedSelfTalk = freq(snapshots.flatMap((s) => s.selfTalkTone ?? []));

  const trendFor = (values: number[]) => {
    if (values.length < 2) return "unknown";
    const first = values[0];
    const last = values[values.length - 1];
    const delta = last - first;
    if (Math.abs(delta) < 5) return "stable";
    return delta > 0 ? "increasing" : "decreasing";
  };

  const stressTrend = trendFor(snapshots.map((s) => s.stressLevel));
  const energyTrend = trendFor(snapshots.map((s) => s.energyLevel));
  const moodTrend = trendFor(moodByDay);

  const moodLabel = avgMoodScore > 0.5 ? "mostly_positive" : avgMoodScore < -0.5 ? "mostly_negative" : "mixed";

  return {
    avgMood: snapshots.length === 0 ? "unknown" : moodLabel,
    avgStress,
    avgEnergy,
    topConcerns,
    repeatedSelfTalk,
    trend: {
      mood: moodTrend,
      stress: stressTrend,
      energy: energyTrend,
    },
  };
}

async function fetchMessagesForWindow(fromTs: number, toTs: number): Promise<MessageRecord[]> {
  const all = await fetchRecentMessages(2000);
  return all.filter((m) => m.ts >= fromTs && m.ts <= toTs);
}

function computeDailyStateForMessages(date: string, messages: MessageRecord[]): Promise<DailyStateSnapshot> {
  const prompt = buildDailyStatePrompt({ date, messages });
  return callLLM<DailyStateSnapshot>("state", prompt);
}

async function computeDailyState(date: string): Promise<DailyStateSnapshot> {
  const dayStart = startOfDay(Date.parse(date));
  const dayEnd = endOfDay(Date.parse(date));
  const messages = await fetchMessagesForWindow(dayStart, dayEnd);
  if (messages.length === 0) {
    return {
      date,
      fromTs: dayStart,
      toTs: dayEnd,
      mood: "unknown",
      energyLevel: 0,
      stressLevel: 0,
      dominantConcerns: [],
      selfTalkTone: [],
      copingPatterns: [],
      underlyingThemes: [],
      notableMoments: [],
    };
  }

  const snapshot = await computeDailyStateForMessages(date, messages);
  const earliest = messages.reduce((min, m) => Math.min(min, m.ts), messages[0].ts);
  const latest = messages.reduce((max, m) => Math.max(max, m.ts), messages[0].ts);

  return {
    ...snapshot,
    date,
    fromTs: earliest,
    toTs: latest,
  };
}

stateRouter.get("/today", async (_req, res) => {
  try {
    const now = Date.now();
    const d = new Date(now);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
    const snapshot = await computeDailyState(date);
    res.json({
      state: snapshot,
      meta: {
        cached: false,
        messageCount: null,
        generatedAt: Date.now(),
      },
    });
  } catch (err: any) {
    console.error("Error in /state/today:", err?.message ?? err);
    res.status(500).json({ error: "Failed to generate daily state" });
  }
});

stateRouter.post("/backfill", async (req, res) => {
  const processed: { date: string; cached: boolean }[] = [];
  try {
    let days = parseInt(String(req.query.days ?? "14"), 10);
    if (Number.isNaN(days)) days = 14;
    days = Math.min(Math.max(days, 1), 30);

    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
      try {
        await computeDailyState(date);
        processed.push({ date, cached: false });
      } catch (err: any) {
        console.error(`Error computing daily state for ${date}:`, err?.message ?? err);
        processed.push({ date, cached: false });
      }
    }

    res.json({
      daysRequested: days,
      processed,
      meta: {
        force: true,
        generatedAt: Date.now(),
      },
    });
  } catch (err: any) {
    console.error("Error in /state/backfill:", err?.message ?? err);
    res.status(500).json({ error: "Failed to backfill daily state" });
  }
});

stateRouter.get("/history", async (req, res) => {
  try {
    const days = clampNumber(req.query.days, 1, 30, 7);
    const snapshots: DailyStateSnapshot[] = await getRecentStateSnapshots(days);
    const summary = summariseStateHistory(snapshots);

    res.json({
      days: snapshots,
      summary,
      meta: {
        daysRequested: days,
        daysReturned: snapshots.length,
        generatedAt: Date.now(),
      },
    });
  } catch (err: any) {
    console.error("Error in /state/history:", err);
    res.status(500).json({ error: "Failed to fetch state history" });
  }
});

export default stateRouter;

export async function getStateHistory(days: number) {
  const clamped = clampNumber(days, 1, 30, 7);
  const snapshots = await getRecentStateSnapshots(clamped);
  const summary = summariseStateHistory(snapshots);
  return { snapshots, summary };
}
