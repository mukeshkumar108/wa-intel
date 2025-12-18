import fs from "fs";
import path from "path";
import { fetchActiveChats, fetchChatMessagesBefore } from "../whatsappClient.js";
import type { MessageRecord } from "../types.js";
import { callLLM } from "../llm.js";
import { buildHeatTriagePrompt, HeatTriageChatSlice } from "../prompts.js";

type HeatTier = "LOW" | "MED" | "HIGH";

type RadarParams = {
  limitChats: number;
  limitPerChat: number;
  includeGroups: boolean;
  runType?: string;
  execute?: boolean;
};

type LlmHeatResult = {
  chatId: string;
  chatDisplayName?: string;
  heatTier: HeatTier;
  heatScore: number;
  signals: string[];
  why: string;
  recommendedBackfill?: { immediate: number; scheduled: number };
  evidenceMessageId?: string | null;
  evidenceText?: string | null;
};

type HeatTriageTopChat = {
  chatId: string;
  chatDisplayName: string;
  heatTier: HeatTier;
  heatScore: number;
  signals: string[];
  why: string;
  recommendedBackfill: { immediate: number; scheduled: number };
  evidenceMessageId: string | null;
  evidenceText: string | null;
};

const OUT_DIR = path.join(process.cwd(), "out", "intel");
const SNAPSHOT_PATH = path.join(OUT_DIR, "heat_triage_snapshots.jsonl");
const LATEST_PATH = path.join(OUT_DIR, "heat_triage_latest.json");
const BATCH_SIZE = 10;
const BATCH_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 500;
const SIGNALS_SET = new Set([
  "AFFECTION",
  "FLIRT",
  "VULNERABILITY",
  "CONFLICT",
  "PLANNING",
  "CHECKIN",
  "LOGISTICS",
  "DRY",
  "UNKNOWN",
]);

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const res: T[][] = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

function truncateBody(body: string | null): string {
  if (!body) return "";
  return body.length > 280 ? body.slice(0, 280) : body;
}

function toChatSlice(chatId: string, displayName: string, messages: MessageRecord[]): HeatTriageChatSlice {
  const sorted = [...messages].sort((a, b) => a.ts - b.ts);
  return {
    chatId,
    chatDisplayName: displayName,
    messages: sorted.map((m) => ({
      id: m.id,
      iso: new Date(m.ts).toISOString(),
      speaker: m.fromMe ? "ME" : "OTHER",
      body: truncateBody(m.body ?? ""),
    })),
  };
}

function backfillForTier(tier: HeatTier) {
  if (tier === "HIGH") return { immediate: 100, scheduled: 400 };
  if (tier === "MED") return { immediate: 100, scheduled: 0 };
  return { immediate: 0, scheduled: 0 };
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(10, score));
}

function normalizeTier(tier: string): HeatTier {
  if (tier === "HIGH" || tier === "MED") return tier;
  return "LOW";
}

function sanitizeSignals(signals: any[]): string[] {
  if (!Array.isArray(signals)) return ["UNKNOWN"];
  const filtered = signals.filter((s) => typeof s === "string" && SIGNALS_SET.has(s));
  return filtered.length ? filtered : ["UNKNOWN"];
}

function withinTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("heat triage timeout")), ms);
    p.then((val) => {
      clearTimeout(t);
      resolve(val);
    }).catch((err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function validateEvidence(result: HeatTriageTopChat, messages: { id: string; body: string }[]): HeatTriageTopChat {
  if (!result.evidenceMessageId) return result;
  const msg = messages.find((m) => m.id === result.evidenceMessageId);
  if (!msg) {
    return {
      ...result,
      heatScore: Math.max(0, result.heatScore - 2),
      evidenceMessageId: null,
      evidenceText: null,
      signals: Array.from(new Set([...result.signals, "UNKNOWN"])),
    };
  }
  if (result.evidenceText && !msg.body.includes(result.evidenceText)) {
    return {
      ...result,
      heatScore: Math.max(0, result.heatScore - 2),
      evidenceMessageId: null,
      evidenceText: null,
      signals: Array.from(new Set([...result.signals, "UNKNOWN"])),
    };
  }
  return result;
}

export async function runRadar(params: RadarParams) {
  const { limitChats, limitPerChat, includeGroups, runType = "manual", execute } = params;
  const chats = await fetchActiveChats(limitChats, includeGroups);
  const filteredChats = chats.filter((c) => {
    if (c.chatId === "status@broadcast") return false;
    if (includeGroups) return true;
    if (c.isGroup) return false;
    if (c.chatId.endsWith("@g.us")) return false;
    return true;
  });

  const chatSlices: HeatTriageChatSlice[] = [];
  let messagesProcessed = 0;

  for (const chat of filteredChats) {
    const chatId = chat.chatId;
    const { messages } = await fetchChatMessagesBefore(chatId, 0, limitPerChat).catch(() => ({
      messages: [] as MessageRecord[],
    }));
    messagesProcessed += messages.length;
    chatSlices.push(toChatSlice(chatId, chat.displayName ?? chatId, messages));
  }

  const batches = chunk(chatSlices, BATCH_SIZE);
  const results: HeatTriageTopChat[] = [];
  let batchesRetried = 0;
  let batchesFailed = 0;
  let chatsFallback = 0;

  for (const batch of batches) {
    if (!batch.length) continue;
    let llmResult: any;
    let attempt = 0;
    let success = false;
    while (attempt < 2 && !success) {
      attempt++;
      try {
        llmResult = await withinTimeout(callLLM<any>("heatTriage", buildHeatTriagePrompt(batch)), BATCH_TIMEOUT_MS);
        success = true;
      } catch (err) {
        if (attempt === 1) batchesRetried++;
        if (attempt >= 2) {
          batchesFailed++;
          console.error("[radar] heat triage LLM failure, giving up batch", err);
          break;
        }
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }
    if (!success) {
      for (const fallback of batch) {
        chatsFallback++;
        results.push({
          chatId: fallback.chatId,
          chatDisplayName: fallback.chatDisplayName,
          heatTier: "LOW",
          heatScore: 0,
          signals: ["UNKNOWN"],
          why: "triage_failed",
          recommendedBackfill: backfillForTier("LOW"),
          evidenceMessageId: null,
          evidenceText: null,
        });
      }
      continue;
    }
    const rawResults: LlmHeatResult[] = Array.isArray(llmResult)
      ? llmResult
      : Array.isArray(llmResult?.results)
        ? llmResult.results
        : [];
    for (const fallback of batch) {
      const match = rawResults.find((r) => r.chatId === fallback.chatId);
      const tier = normalizeTier(match?.heatTier ?? "LOW");
      const score = clampScore(match?.heatScore ?? 0);
      const recommendedBackfill = backfillForTier(tier);
      const validated = validateEvidence(
        {
          chatId: fallback.chatId,
          chatDisplayName: match?.chatDisplayName ?? fallback.chatDisplayName,
          heatTier: tier,
          heatScore: score,
          signals: sanitizeSignals(match?.signals ?? []),
          why: typeof match?.why === "string" ? match.why : "",
          recommendedBackfill,
          evidenceMessageId: match?.evidenceMessageId ?? null,
          evidenceText: match?.evidenceText ?? null,
        },
        fallback.messages.map((m) => ({ id: m.id, body: m.body }))
      );
      results.push({
        chatId: fallback.chatId,
        chatDisplayName: validated.chatDisplayName,
        heatTier: validated.heatTier,
        heatScore: validated.heatScore,
        signals: validated.signals,
        why: validated.why,
        recommendedBackfill: validated.recommendedBackfill,
        evidenceMessageId: validated.evidenceMessageId,
        evidenceText: validated.evidenceText,
      });
    }
  }

  const sorted = results.sort((a, b) => b.heatScore - a.heatScore);
  const storedAt = Date.now();
  const payload = {
    storedAt,
    params: { limitChats, limitPerChat, includeGroups, runType, execute },
    summary: {
      chatsProcessed: results.length,
      batches: batches.length,
      messagesProcessed,
      batchesFailed,
      batchesRetried,
      chatsFallback,
    },
    topChats: sorted,
  };

  ensureOutDir();
  fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(payload) + "\n");
  fs.writeFileSync(LATEST_PATH, JSON.stringify(payload, null, 2));

  return payload;
}
