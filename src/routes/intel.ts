import { Router } from "express";
import { bootstrapIntel, recentIntelFacts } from "../services/intelService.js";
import { runRadar } from "../services/radarService.js";
import { orchestrateRun, orchestrateStatus } from "../services/orchestratorService.js";
import {
  readLatestTimeOfDayMetrics,
  readTimeOfDayHistory,
  runTimeOfDayMetrics,
} from "../services/timeOfDayMetricsService.js";
import {
  readLatestDailyMetrics,
  readDailyMetricsHistory,
  runDailyMetrics,
} from "../services/metricsDailyService.js";
import { startRun, finishRun, saveArtifact, saveEvents, saveBackfillPosts, getLastBackfillPostedByChatIds } from "../services/intelPersistence.js";
import { fetchRecentMessages, fetchChatMessagesBefore, fetchServiceStatus } from "../whatsappClient.js";
import { callLLM } from "../llm.js";
import { buildSignalsDigestPrompt, buildSignalsEventsPrompt, SignalsChat } from "../prompts.js";
import { pool } from "../db.js";
import { readOrchestratorState, buildSchedulerStatus } from "../services/orchestratorService.js";
import { enqueueJob } from "../services/jobQueue.js";
import { getChatState, upsertChatState } from "../services/chatPipelineState.js";
import { getRecentHighSignalChatIds } from "../services/intelPersistence.js";
import { setBackfillTargets } from "../whatsappClient.js";

async function fetchLatestArtifactPreview(artifactType: string) {
  try {
    const res = await pool.query("SELECT payload FROM intel_artifacts WHERE artifact_type = $1 ORDER BY id DESC LIMIT 1", [
      artifactType,
    ]);
    if (!res.rows?.length) return null;
    const payload = res.rows[0]?.payload;
    if (!payload || typeof payload !== "object") return payload ?? null;
    const clone: any = { ...payload };
    if (Array.isArray(clone.topChats)) clone.topChats = clone.topChats.slice(0, 5);
    if (Array.isArray(clone.events)) clone.events = clone.events.slice(0, 10);
    if (Array.isArray(clone.watchlist)) clone.watchlist = clone.watchlist.slice(0, 5);
    if (Array.isArray(clone.atBaseline)) clone.atBaseline = clone.atBaseline.slice(0, 5);
    if (Array.isArray(clone.belowBaseline)) clone.belowBaseline = clone.belowBaseline.slice(0, 5);

    if (artifactType === "metrics_daily_snapshot" && Array.isArray(clone.results)) {
      const maxItems = 10;
      const filtered = clone.results.filter((r: any) => {
        if (!r || typeof r !== "object") return false;
        const windows = r.metricsByWindow ?? {};
        const hasActive = Object.values(windows).some((w: any) => {
          const msgCount = Number(w?.msgCountTotal ?? 0);
          const covMsgs = Number(w?.coverage?.messagesInWindow ?? 0);
          const covQual = w?.coverage?.coverageQuality;
          return msgCount > 0 || covMsgs > 0 || covQual !== "EMPTY";
        });
        return hasActive;
      });
      clone.totalChats = clone.results.length;
      clone.activeChats = filtered.length;
      clone.omittedInactiveChats = Math.max(0, clone.results.length - filtered.length);
      clone.results = filtered.slice(0, maxItems);
    }

    if (artifactType === "metrics_timeofday_snapshot" && Array.isArray(clone.results)) {
      const maxItems = 10;
      const filtered = clone.results.filter((r: any) => {
        if (!r || typeof r !== "object") return false;
        const total =
          Number(r?.counts?.morning ?? 0) +
          Number(r?.counts?.day ?? 0) +
          Number(r?.counts?.evening ?? 0) +
          Number(r?.counts?.night ?? 0);
        return total > 0;
      });
      clone.totalChats = clone.results.length;
      clone.activeChats = filtered.length;
      clone.omittedInactiveChats = Math.max(0, clone.results.length - filtered.length);
      clone.results = filtered.slice(0, maxItems);
    }

    return clone;
  } catch (err) {
    console.error("[intel/today] fetchLatestArtifactPreview failed", err);
    return null;
  }
}

async function fetchRecentRuns() {
  try {
    const res = await pool.query(
      "SELECT id, kind, status, run_type, created_at, finished_at, error FROM intel_runs ORDER BY id DESC LIMIT 20"
    );
    return res.rows ?? [];
  } catch (err) {
    console.error("[intel/today] fetchRecentRuns failed", err);
    return [];
  }
}

async function fetchEventsRollup(nowMs: number) {
  const warnings: string[] = [];
  const last24h = nowMs - 24 * 60 * 60 * 1000;
  const last7d = nowMs - 7 * 24 * 60 * 60 * 1000;
  let last24hCounts: any[] = [];
  let last7dCounts: any[] = [];
  let topChats7d: any[] = [];
  try {
    const res24 = await pool.query("SELECT type, COUNT(*) as count FROM intel_events WHERE ts >= $1 GROUP BY type", [
      last24h,
    ]);
    last24hCounts = res24.rows ?? [];
    const res7 = await pool.query("SELECT type, COUNT(*) as count FROM intel_events WHERE ts >= $1 GROUP BY type", [
      last7d,
    ]);
    last7dCounts = res7.rows ?? [];
    const top = await pool.query(
      "SELECT chat_id, COUNT(*) as count, MAX(ts) as latest_ts FROM intel_events WHERE ts >= $1 GROUP BY chat_id ORDER BY count DESC LIMIT 10",
      [last7d]
    );
    topChats7d = top.rows ?? [];
  } catch (err) {
    console.error("[intel/today] fetchEventsRollup failed", err);
    warnings.push("events_rollup_error");
  }
  return { last24hCounts, last7dCounts, topChats7d, warnings };
}

export const intelRouter = Router();

intelRouter.post("/intel/bootstrap", async (req, res) => {
  const runId = await startRun({
    kind: "bootstrap_run",
    runType: (req.query.runType as string | undefined) ?? "manual",
    params: req.query,
  });
  try {
    const hours = Math.min(Number(req.query.hours ?? 72) || 72, 240);
    const limitChats = Math.min(Number(req.query.limitChats ?? 50) || 50, 500);
    const limitPerChat = Math.min(Number(req.query.limitPerChat ?? 200) || 200, 2000);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const runType = (req.query.runType as string | undefined) ?? "manual";
    const result = await bootstrapIntel({ hours, limitChats, limitPerChat, includeGroups, runType });
    await saveArtifact({ runId, artifactType: "bootstrap_result", payload: result });
    await finishRun(runId, { status: "ok" });
    res.json(result);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/bootstrap:", err);
    res.status(500).json({ error: "Failed to run intel bootstrap" });
  }
});

intelRouter.get("/intel/facts/recent", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    const facts = await recentIntelFacts(limit);
    res.json({ facts });
  } catch (err: any) {
    console.error("Error in /intel/facts/recent:", err);
    res.status(500).json({ error: "Failed to load intel facts" });
  }
});

intelRouter.post("/intel/radar/run", async (req, res) => {
  const runId = await startRun({
    kind: "radar_run",
    runType: (req.query.runType as string | undefined) ?? "manual",
    params: req.query,
  });
  try {
    const limitChats = Math.min(Number(req.query.limitChats ?? 50) || 50, 500);
    const limitPerChat = Math.min(Number(req.query.limitPerChat ?? 30) || 30, 2000);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const runType = (req.query.runType as string | undefined) ?? "manual";
    const execute = String(req.query.execute ?? "false").toLowerCase() === "true";
    const result = await runRadar({ limitChats, limitPerChat, includeGroups, runType, execute });
    await saveArtifact({ runId, artifactType: "heat_triage_result", payload: result });
    await finishRun(runId, { status: "ok" });
    res.json(result);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/radar/run:", err);
    res.status(500).json({ error: "Failed to run radar" });
  }
});

intelRouter.get("/intel/orchestrate/status", async (_req, res) => {
  try {
    const result = await orchestrateStatus();
    res.json(result);
  } catch (err: any) {
    console.error("Error in /intel/orchestrate/status:", err);
    res.status(500).json({ error: "Failed to load orchestrator status" });
  }
});

intelRouter.post("/intel/orchestrate/run", async (req, res) => {
  const runId = await startRun({
    kind: "orchestrate_run",
    runType: (req.query.runType as string | undefined) ?? "manual",
    params: req.query,
  });
  try {
    const force = String(req.query.force ?? "0") === "1";
    const runType = (req.query.runType as string | undefined) ?? "manual";
    const limitChats = Math.min(Number(req.query.limitChats ?? 50) || 50, 500);
    const limitPerChat = Math.min(Number(req.query.limitPerChat ?? 30) || 30, 2000);
    const debug = String(req.query.debug ?? "false").toLowerCase() === "true";
    const result = await orchestrateRun({ force, runType, limitChats, limitPerChat, debug });
    await saveArtifact({ runId, artifactType: "orchestrate_result", payload: result });
    await finishRun(runId, { status: "ok" });
    res.json(result);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/orchestrate/run:", err);
    res.status(500).json({ error: "Failed to run orchestrator" });
  }
});

intelRouter.post("/intel/metrics/time-of-day/run", async (req, res) => {
  const runId = await startRun({
    kind: "metrics_timeofday_run",
    runType: (req.query.runType as string | undefined) ?? "manual",
    params: req.query,
  });
  try {
    const limitChats = Math.min(Number(req.query.limitChats ?? 50) || 50, 500);
    const limitPerChat = Math.min(Number(req.query.limitPerChat ?? 200) || 200, 2000);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const activeOnly = String(req.query.activeOnly ?? "false").toLowerCase() === "true";
    const activeDays = Math.min(Number(req.query.activeDays ?? 30) || 30, 365);
    const recentLimit = Math.min(Number(req.query.recentLimit ?? 4000) || 4000, 10000);
    const maxChats = Math.min(Number(req.query.maxChats ?? 50) || 50, 500);
    const minMsgs = Math.min(Number(req.query.minMsgs ?? (activeOnly ? 1 : 0)) || (activeOnly ? 1 : 0), 5000);
    const result = await runTimeOfDayMetrics({
      limitChats,
      limitPerChat,
      includeGroups,
      activeOnly,
      activeDays,
      recentLimit,
      maxChats,
      minMsgs,
    });
    await saveArtifact({ runId, artifactType: "metrics_timeofday_snapshot", payload: result });
    await finishRun(runId, { status: "ok" });
    res.json(result);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/metrics/time-of-day/run:", err);
    res.status(500).json({ error: "Failed to run time-of-day metrics" });
  }
});

intelRouter.get("/intel/metrics/time-of-day/latest", async (_req, res) => {
  try {
    const latest = readLatestTimeOfDayMetrics();
    if (!latest) return res.status(404).json({ error: "No metrics available" });
    res.json(latest);
  } catch (err: any) {
    console.error("Error in /intel/metrics/time-of-day/latest:", err);
    res.status(500).json({ error: "Failed to load latest metrics" });
  }
});

intelRouter.get("/intel/metrics/time-of-day", async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days ?? 30) || 30, 365);
    const history = readTimeOfDayHistory(days);
    res.json({ days, history });
  } catch (err: any) {
    console.error("Error in /intel/metrics/time-of-day:", err);
    res.status(500).json({ error: "Failed to load metrics history" });
  }
});

intelRouter.post("/intel/metrics/daily/run", async (req, res) => {
  const runId = await startRun({
    kind: "metrics_daily_run",
    runType: (req.query.runType as string | undefined) ?? "manual",
    params: req.query,
  });
  try {
    const limitChats = Math.min(Number(req.query.limitChats ?? 50) || 50, 500);
    const limitPerChat = Math.min(Number(req.query.limitPerChat ?? 500) || 500, 2000);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const windowsRaw = String(req.query.windows ?? "1");
    const windows = windowsRaw
      .split(",")
      .map((w) => Number(w.trim()))
      .filter((w) => Number.isFinite(w) && w > 0)
      .slice(0, 10);
    const tz = typeof req.query.tz === "string" && req.query.tz.trim() ? req.query.tz.trim() : undefined;
    const activeOnly = String(req.query.activeOnly ?? "false").toLowerCase() === "true";
    const activeDays = Math.min(Number(req.query.activeDays ?? 30) || 30, 365);
    const recentLimit = Math.min(Number(req.query.recentLimit ?? 4000) || 4000, 10000);
    const maxChats = Math.min(Number(req.query.maxChats ?? 50) || 50, 500);
    const minMsgs = Math.min(Number(req.query.minMsgs ?? (activeOnly ? 1 : 0)) || (activeOnly ? 1 : 0), 5000);
    const result = await runDailyMetrics({
      limitChats,
      limitPerChat,
      includeGroups,
      windows: windows.length ? windows : [1],
      tz,
      activeOnly,
      activeDays,
      recentLimit,
      maxChats,
      minMsgs,
    });
    await saveArtifact({ runId, artifactType: "metrics_daily_snapshot", payload: result });
    await finishRun(runId, { status: "ok" });
    res.json(result);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/metrics/daily/run:", err);
    res.status(500).json({ error: "Failed to run daily metrics" });
  }
});

intelRouter.get("/intel/metrics/daily/latest", async (_req, res) => {
  try {
    const latest = readLatestDailyMetrics();
    if (!latest) return res.status(404).json({ error: "No metrics available" });
    res.json(latest);
  } catch (err: any) {
    console.error("Error in /intel/metrics/daily/latest:", err);
    res.status(500).json({ error: "Failed to load latest daily metrics" });
  }
});

intelRouter.get("/intel/metrics/daily", async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days ?? 30) || 30, 365);
    const history = readDailyMetricsHistory(days);
    res.json({ days, history });
  } catch (err: any) {
    console.error("Error in /intel/metrics/daily:", err);
    res.status(500).json({ error: "Failed to load daily metrics history" });
  }
});

intelRouter.get("/intel/coverage/active", async (req, res) => {
  const runId = await startRun({
    kind: "coverage_active_run",
    runType: "manual",
    params: req.query,
  });
  try {
    const days = Math.min(Number(req.query.days ?? 90) || 90, 365);
    const baseline = Math.min(Number(req.query.baseline ?? 50) || 50, 5000);
    const recentLimit = Math.min(Number(req.query.recentLimit ?? 2000) || 2000, 10000);
    const maxChats = Math.min(Number(req.query.maxChats ?? 50) || 50, 500);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const minMessages = Math.min(Number(req.query.minMessages ?? 10) || 10, 5000);
    const excludeBroadcast = String(req.query.excludeBroadcast ?? "true").toLowerCase() === "true";
    const excludeLid = String(req.query.excludeLid ?? "true").toLowerCase() === "true";
    const nowTs = Date.now();
    const cutoffTs = nowTs - days * 24 * 60 * 60 * 1000;

    const recentMessages = await fetchRecentMessages(recentLimit);
    const seen = new Set<string>();
    const chatIds: string[] = [];
    for (const m of recentMessages) {
      if (m.ts < cutoffTs) continue;
      const isGroup = m.chatId.endsWith("@g.us");
      if (!includeGroups && isGroup) continue;
      if (excludeBroadcast && (m.chatId === "status@broadcast" || m.chatId.includes("@broadcast"))) continue;
      if (excludeLid && m.chatId.endsWith("@lid")) continue;
      if (seen.has(m.chatId)) continue;
      seen.add(m.chatId);
      chatIds.push(m.chatId);
      if (chatIds.length >= maxChats) break;
    }

    const atBaseline: { chatId: string; sampledCount: number }[] = [];
    const belowBaseline: { chatId: string; sampledCount: number; error?: string }[] = [];
    let activeChatsWithMinContext = 0;

    for (const chatId of chatIds) {
      try {
        const { messages } = await fetchChatMessagesBefore(chatId, nowTs, baseline);
        const count = messages.length;
        if (count >= minMessages) activeChatsWithMinContext++;
        if (count >= baseline) atBaseline.push({ chatId, sampledCount: count });
        else belowBaseline.push({ chatId, sampledCount: count });
      } catch (err: any) {
        belowBaseline.push({ chatId, sampledCount: 0, error: err?.message ?? String(err) });
      }
    }

    const activeChatsTotal = chatIds.length;
    const activeChatsAtBaseline = atBaseline.length;
    const activeCoveragePct = activeChatsTotal ? Math.round((activeChatsAtBaseline / activeChatsTotal) * 1000) / 10 : 0;
    const activeMinContextCoveragePct = activeChatsTotal
      ? Math.round((activeChatsWithMinContext / activeChatsTotal) * 1000) / 10
      : 0;

    const responsePayload = {
      nowTs,
      days,
      baseline,
      recentLimit,
      maxChats,
      minMessages,
      excludeBroadcast,
      excludeLid,
      activeChatsTotal,
      activeChatsWithMinContext,
      activeChatsAtBaseline,
      activeCoveragePct,
      activeMinContextCoveragePct,
      belowBaseline,
      atBaseline,
    };
    await saveArtifact({ runId, artifactType: "coverage_active_snapshot", payload: responsePayload });
    await finishRun(runId, { status: "ok" });
    res.json(responsePayload);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/coverage/active:", err);
    res.status(500).json({ error: "Failed to load active coverage" });
  }
});

intelRouter.post("/intel/signals/run", async (req, res) => {
  const runId = await startRun({
    kind: "signals_run",
    runType: (req.query.runType as string | undefined) ?? "manual",
    params: req.query,
  });
  try {
    const hours = Math.min(Number(req.query.hours ?? 24) || 24, 240);
    const minMsgs = Math.min(Number(req.query.minMsgs ?? 8) || 8, 5000);
    const maxChats = Math.min(Number(req.query.maxChats ?? 30) || 30, 200);
    const perChat = Math.min(Number(req.query.perChat ?? 30) || 30, 200);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const runType = (req.query.runType as string | undefined) ?? "manual";

    const now = Date.now();
    const cutoffTs = now - hours * 60 * 60 * 1000;
    const recent = await fetchRecentMessages(5000);
    const grouped = new Map<string, SignalsChat>();

    for (const m of recent) {
      if (m.ts < cutoffTs) continue;
      const isGroup = m.chatId.endsWith("@g.us");
      if (!includeGroups && isGroup) continue;
      if (m.chatId === "status@broadcast" || m.chatId.includes("@broadcast")) continue;
      if (m.chatId.endsWith("@lid")) continue;
      let entry = grouped.get(m.chatId);
      if (!entry) {
        entry = { chatId: m.chatId, messageCount: 0, messages: [] };
        grouped.set(m.chatId, entry);
      }
      entry.messageCount++;
      if (entry.messages.length < perChat) {
        entry.messages.push({ ts: m.ts, fromMe: m.fromMe, body: m.body, type: m.type });
      }
    }

    const chats = Array.from(grouped.values())
      .filter((c) => c.messageCount >= minMsgs)
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, maxChats);

    const prompt = buildSignalsDigestPrompt({ windowHours: hours, generatedAtTs: now, chats });
    let llmResp: any;
    try {
      llmResp = await callLLM<any>("signals", prompt);
    } catch (err) {
      await finishRun(runId, { status: "error", error: (err as any)?.message ?? String(err) });
      console.error("Error in /intel/signals/run LLM:", err);
      return res.status(500).json({ error: "Failed to run signals LLM" });
    }

    const responsePayload = llmResp ?? {};
    await saveArtifact({ runId, artifactType: "signals_snapshot", payload: responsePayload });
    await finishRun(runId, { status: "ok" });
    res.json(responsePayload);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/signals/run:", err);
    res.status(500).json({ error: "Failed to run signals" });
  }
});

intelRouter.post("/intel/signals/events/run", async (req, res) => {
  const runId = await startRun({
    kind: "signals_run",
    runType: (req.query.runType as string | undefined) ?? "manual",
    params: req.query,
  });
  try {
    const hours = Math.min(Number(req.query.hours ?? 24) || 24, 240);
    const minMsgs = Math.min(Number(req.query.minMsgs ?? 1) || 1, 5000);
    const maxChats = Math.min(Number(req.query.maxChats ?? 30) || 30, 200);
    const perChat = Math.min(Number(req.query.perChat ?? 30) || 30, 200);
    const maxEvents = Math.min(Number(req.query.maxEvents ?? 50) || 50, 500);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const runType = (req.query.runType as string | undefined) ?? "manual";
    const recentLimit = Math.min(Number(req.query.recentLimit ?? 4000) || 4000, 10000);

    const nowTs = Date.now();
    const cutoffTs = nowTs - hours * 60 * 60 * 1000;
    const recent = await fetchRecentMessages(recentLimit);
    const grouped = new Map<string, SignalsChat>();
    let minInputMsgTs: number | null = null;
    let maxInputMsgTs: number | null = null;

    for (const m of recent) {
      if (m.ts < cutoffTs) continue;
      const isGroup = m.chatId.endsWith("@g.us");
      if (!includeGroups && isGroup) continue;
      if (m.chatId === "status@broadcast" || m.chatId.includes("@broadcast")) continue;
      if (m.chatId.endsWith("@lid")) continue;
      minInputMsgTs = minInputMsgTs === null ? m.ts : Math.min(minInputMsgTs, m.ts);
      maxInputMsgTs = maxInputMsgTs === null ? m.ts : Math.max(maxInputMsgTs, m.ts);
      let entry = grouped.get(m.chatId);
      if (!entry) {
        entry = { chatId: m.chatId, messageCount: 0, messages: [] };
        grouped.set(m.chatId, entry);
      }
      entry.messageCount++;
      if (entry.messages.length < perChat) {
        entry.messages.push({ ts: m.ts, fromMe: m.fromMe, body: m.body, type: m.type });
      }
    }

    const chats = Array.from(grouped.values())
      .filter((c) => c.messageCount >= minMsgs)
      .sort((a, b) => {
        const aLatest = a.messages.reduce((max, m) => Math.max(max, m.ts), 0);
        const bLatest = b.messages.reduce((max, m) => Math.max(max, m.ts), 0);
        if (bLatest === aLatest) return b.messageCount - a.messageCount;
        return bLatest - aLatest;
      })
      .slice(0, maxChats);

    const prompt = buildSignalsEventsPrompt({ windowHours: hours, generatedAtTs: nowTs, maxEvents, chats });
    let llmResp: any;
    try {
      llmResp = await callLLM<any>("signals", prompt);
    } catch (err) {
      await finishRun(runId, { status: "error", error: (err as any)?.message ?? String(err) });
      console.error("Error in /intel/signals/events/run LLM:", err);
      return res.status(500).json({ error: "signals_llm_failed" });
    }

    if (!llmResp || typeof llmResp !== "object" || !("counts" in llmResp) || !("events" in llmResp)) {
      await finishRun(runId, { status: "error", error: "signals_llm_invalid_json" });
      return res.status(500).json({ error: "signals_llm_invalid_json" });
    }

    const responsePayload = llmResp;
    responsePayload.generatedAtTs = nowTs;
    responsePayload.windowHours = hours;
    const globalMaxTs = maxInputMsgTs ?? null;
    if (Array.isArray(responsePayload.events)) {
      responsePayload.events = responsePayload.events
        .map((e: any) => {
          const coercedTs = Number(e?.ts);
          const chatId = e?.chatId;
          const chatMaxTs =
            chats.find((c) => c.chatId === chatId)?.messages.reduce((mx, m) => Math.max(mx, m.ts), 0) ??
            globalMaxTs ??
            null;
          const isTsValid = Number.isFinite(coercedTs) && coercedTs >= cutoffTs && coercedTs <= nowTs + 5 * 60 * 1000;
          const finalTs = isTsValid ? coercedTs : chatMaxTs;
          return {
            ...e,
            ts: finalTs ?? null,
          };
        })
        .sort((a: any, b: any) => (b?.ts ?? 0) - (a?.ts ?? 0))
        .slice(0, maxEvents);
    }

    responsePayload.nowTs = nowTs;
    responsePayload.cutoffTs = cutoffTs;
    responsePayload.minInputMsgTs = minInputMsgTs;
    responsePayload.maxInputMsgTs = maxInputMsgTs;

    await saveArtifact({ runId, artifactType: "signals_events_snapshot", payload: responsePayload });
    await saveEvents(
      runId,
      Array.isArray(responsePayload.events)
        ? responsePayload.events.map((e: any) => ({
            ts: e?.ts,
            chatId: e?.chatId,
            type: e?.type,
            direction: e?.direction,
            confidence: e?.confidence,
          }))
        : []
    );
    await finishRun(runId, { status: "ok" });
    res.json(responsePayload);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/signals/events/run:", err);
    res.status(500).json({ error: "Failed to run signals events" });
  }
});

intelRouter.get("/intel/today", async (_req, res) => {
  const warnings: string[] = [];
  const nowTs = Date.now();
  let serviceA: any = null;
  try {
    serviceA = await fetchServiceStatus();
  } catch (err) {
    warnings.push("serviceA_status_error");
  }

  const orchestratorState = readOrchestratorState();
  const scheduler = buildSchedulerStatus(orchestratorState, orchestratorState.lastCoverage, nowTs);

  const latestArtifacts: Record<string, any> = {};
  const artifactTypes = [
    "orchestrate_result",
    "heat_triage_result",
    "signals_events_snapshot",
    "open_loops_refresh_result",
    "metrics_daily_snapshot",
    "metrics_timeofday_snapshot",
    "coverage_active_snapshot",
  ];
  for (const type of artifactTypes) {
    latestArtifacts[type] = await fetchLatestArtifactPreview(type);
  }

  const runs = await fetchRecentRuns();
  const rollup = await fetchEventsRollup(nowTs);
  warnings.push(...(rollup.warnings ?? []));

  res.json({
    nowTs,
    serviceAStatus: serviceA
      ? {
          state: serviceA?.state ?? serviceA?.clientState ?? null,
          needsQr: serviceA?.needsQr ?? null,
          startupInfillStatus: serviceA?.startupInfillStatus ?? null,
          startupInfillStartedAt: serviceA?.startupInfillStartedAt ?? null,
          startupInfillFinishedAt: serviceA?.startupInfillFinishedAt ?? null,
          startupInfillFetchedChats: serviceA?.startupInfillFetchedChats ?? null,
          startupInfillFetchedMessages: serviceA?.startupInfillFetchedMessages ?? null,
          startupInfillError: serviceA?.startupInfillError ?? null,
        }
      : null,
    scheduler,
    latestArtifacts,
    runs,
    eventsRollup: {
      last24hCounts: rollup.last24hCounts,
      last7dCounts: rollup.last7dCounts,
      topChats7d: rollup.topChats7d,
    },
    warnings,
  });
});

intelRouter.post("/intel/watermarks/sync", async (req, res) => {
  const runId = await startRun({
    kind: "watermarks_sync_run",
    runType: (req.query.runType as string | undefined) ?? "scheduled",
    params: req.query,
  });
  try {
    const activeDays = Math.min(Number(req.query.activeDays ?? 30) || 30, 365);
    const recentLimit = Math.min(Number(req.query.recentLimit ?? 4000) || 4000, 20000);
    const maxChats = Math.min(Number(req.query.maxChats ?? 30) || 30, 200);
    const runType = (req.query.runType as string | undefined) ?? "scheduled";
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const now = Date.now();
    const cutoff = now - activeDays * 24 * 60 * 60 * 1000;

    const recentMsgs = await fetchRecentMessages(recentLimit);
    const recentChats: string[] = [];
    const seenRecent = new Set<string>();
    for (const m of recentMsgs) {
      if (m.ts < cutoff) continue;
      const isGroup = m.chatId.endsWith("@g.us");
      if (!includeGroups && isGroup) continue;
      if (m.chatId === "status@broadcast" || m.chatId.includes("@broadcast") || m.chatId.endsWith("@lid")) continue;
      if (seenRecent.has(m.chatId)) continue;
      seenRecent.add(m.chatId);
      recentChats.push(m.chatId);
      if (recentChats.length >= maxChats) break;
    }

    const highSignalChats = await getRecentHighSignalChatIds({
      hours: 72,
      types: (process.env.ORCH_EVENT_PRIORITY_TYPES ?? "sexual_flirt,secrecy_concealment,meetup_plan")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      limit: maxChats,
    }).catch(() => [] as string[]);

    const candidates = Array.from(new Set([...recentChats, ...highSignalChats])).slice(0, maxChats);

    let checked = 0;
    let updated = 0;
    let enqueuedMetrics = 0;
    let enqueuedSignals = 0;

    for (const chatId of candidates) {
      checked++;
      const { messages } = await fetchChatMessagesBefore(chatId, now, 200).catch(() => ({ messages: [] as any[] }));
      if (!messages.length) continue;
      const newestTs = Math.max(...messages.map((m) => m.ts));
      const oldestTs = Math.min(...messages.map((m) => m.ts));
      const state = await getChatState(chatId);
      const prevOldest = Number(state?.oldest_ts_seen_ms ?? 0) || null;
      const prevSeen = Number(state?.seen_msg_count ?? 0) || 0;
      const newSeen = Math.max(prevSeen, messages.length);
      const movedBack = prevOldest !== null && oldestTs <= prevOldest - 7 * 24 * 60 * 60 * 1000;
      const thresholds = [50, 100, 200];
      const crossedThreshold = thresholds.some((t) => prevSeen < t && newSeen >= t);

      await upsertChatState(chatId, {
        oldest_ts_seen_ms: prevOldest === null ? oldestTs : Math.min(prevOldest, oldestTs),
        newest_ts_seen_ms: Math.max(Number(state?.newest_ts_seen_ms ?? 0) || 0, newestTs),
        seen_msg_count: newSeen,
        last_run_at: now,
        last_run_type: runType,
      });
      updated++;

      if (movedBack || crossedThreshold) {
        await enqueueJob("metrics_daily_chat", { chatId, windows: "1d,7d,30d" }, `metrics_daily_${chatId}`);
        await enqueueJob("signals_events_chat", { chatId, hours: 72 }, `signals_events_${chatId}`);
        enqueuedMetrics++;
        enqueuedSignals++;
      }
    }

    const payload = { now, activeDays, recentLimit, maxChats, checked, updated, enqueuedMetrics, enqueuedSignals };
    await saveArtifact({ runId, artifactType: "watermarks_sync_result", payload });
    await finishRun(runId, { status: "ok" });
    res.json(payload);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/watermarks/sync:", err);
    res.status(500).json({ error: "Failed to sync watermarks" });
  }
});

intelRouter.get("/intel/chat/:chatId/latest", async (req, res) => {
  const chatId = req.params.chatId;
  try {
    const artifacts: Record<string, any> = {};
    const types = ["metrics_daily_chat_snapshot", "signals_events_chat_snapshot", "relationship_profile"];
    for (const type of types) {
      const result = await pool.query(
        "SELECT payload FROM intel_artifacts WHERE artifact_type = $1 AND chat_id = $2 ORDER BY id DESC LIMIT 1",
        [type, chatId]
      );
      artifacts[type] = result.rows?.[0]?.payload ?? null;
    }

    let eventCounts: any[] = [];
    try {
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const ev = await pool.query("SELECT type, COUNT(*) as count FROM intel_events WHERE chat_id = $1 AND ts >= $2 GROUP BY type", [
        chatId,
        since,
      ]);
      eventCounts = ev.rows ?? [];
    } catch (err) {
      console.error("[intel/chat/latest] events query failed", err);
    }

    res.json({ chatId, artifacts, eventCounts });
  } catch (err: any) {
    console.error("Error in /intel/chat/:chatId/latest:", err);
    res.status(500).json({ error: "Failed to load chat artifacts" });
  }
});

intelRouter.post("/intel/backfill/chat/:chatId", async (req, res) => {
  const chatId = req.params.chatId;
  const runId = await startRun({
    kind: "backfill_chat_run",
    runType: (req.query.runType as string | undefined) ?? "manual",
    params: req.query,
  });
  try {
    const targetMessages = Math.max(50, Math.min(Number(req.query.targetMessages ?? 500) || 500, 500));
    await setBackfillTargets([{ chatId, targetMessages }]);
    const now = Date.now();
    await saveBackfillPosts([{ chatId, ts: now }], null);
    try {
      const evidence = await getLastBackfillPostedByChatIds([chatId]);
      const written = Object.keys(evidence).length;
      if (written < 1) {
        console.error("[intel/backfill/chat] invariant violated: backfill_target_posted missing", { chatId });
      }
    } catch (err) {
      console.error("[intel/backfill/chat] invariant check failed", err);
    }
    const payload = { ok: true, chatId, targetMessages, serviceA: { ok: true } };
    await saveArtifact({ runId, artifactType: "backfill_chat_result", chatId, payload });
    await finishRun(runId, { status: "ok" });
    res.json(payload);
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /intel/backfill/chat:", err);
    res.status(500).json({ error: "Failed to post backfill target" });
  }
});

intelRouter.get("/intel/audit", async (req, res) => {
  const nowTs = Date.now();
  const hours = Math.min(Number(req.query.hours ?? 24) || 24, 168);
  const since = nowTs - hours * 60 * 60 * 1000;
  const tables: any = {};
  const warnings: string[] = [];

  async function safeQuery(label: string, sql: string, params: any[] = []) {
    try {
      const r = await pool.query(sql, params);
      return r;
    } catch (err: any) {
      warnings.push(`${label}_error`);
      tables[label] = { error: err?.message ?? String(err) };
      return null;
    }
  }

  // intel_runs
  const runsRes = await safeQuery(
    "intel_runs",
    "SELECT COUNT(*) as count, MAX(id) as last_id, MAX(started_at) as last_started_at, MAX(finished_at) as last_finished_at, MAX(started_at) FILTER (WHERE kind='orchestrate_run') as last_orchestrate_at, MAX(started_at) FILTER (WHERE kind='signals_run') as last_signals_at FROM intel_runs"
  );
  if (runsRes) {
    const row = runsRes.rows?.[0] ?? {};
    tables.intel_runs = {
      totalCount: Number(row?.count ?? 0),
      lastId: row?.last_id ?? null,
      lastStartedAt: row?.last_started_at ?? null,
      lastFinishedAt: row?.last_finished_at ?? null,
      lastOrchestrateAt: row?.last_orchestrate_at ?? null,
      lastSignalsAt: row?.last_signals_at ?? null,
    };
  }

  // intel_artifacts
  const artRes = await safeQuery(
    "intel_artifacts",
    "SELECT COUNT(*) as count, MAX(id) as last_id, MAX(created_at) as last_created_at FROM intel_artifacts"
  );
  if (artRes) {
    const row = artRes.rows?.[0] ?? {};
    tables.intel_artifacts = {
      totalCount: Number(row?.count ?? 0),
      lastId: row?.last_id ?? null,
      lastCreatedAt: row?.last_created_at ?? null,
    };
  }

  // intel_events
  const evRes = await safeQuery(
    "intel_events",
    "SELECT COUNT(*) as count, MAX(id) as last_id, MAX(ts) as last_event_ts, MAX(created_at) as last_created_at FROM intel_events"
  );
  if (evRes) {
    const row = evRes.rows?.[0] ?? {};
    tables.intel_events = {
      totalCount: Number(row?.count ?? 0),
      lastId: row?.last_id ?? null,
      lastEventTs: row?.last_event_ts ?? null,
      lastCreatedAt: row?.last_created_at ?? null,
    };
  }

  // jobs
  const jobsRes = await safeQuery(
    "jobs",
    "SELECT COUNT(*) as count, MAX(id) as last_id, MAX(created_at) as last_created_at FROM jobs"
  );
  if (jobsRes) {
    const row = jobsRes.rows?.[0] ?? {};
    const grouped = await safeQuery(
      "jobs_grouped",
      "SELECT status, type, COUNT(*) as count FROM jobs GROUP BY status, type"
    );
    tables.jobs = {
      totalCount: Number(row?.count ?? 0),
      lastId: row?.last_id ?? null,
      lastCreatedAt: row?.last_created_at ?? null,
      grouped: grouped?.rows ?? [],
    };
  }

  // chat_pipeline_state
  const cpsRes = await safeQuery(
    "chat_pipeline_state",
    "SELECT COUNT(*) as count, MAX(last_run_at) as last_run_at FROM chat_pipeline_state"
  );
  if (cpsRes) {
    const row = cpsRes.rows?.[0] ?? {};
    tables.chat_pipeline_state = {
      totalCount: Number(row?.count ?? 0),
      lastUpdatedAt: row?.last_run_at ?? null,
    };
  }

  // last24h / windowed
  const last24h: any = {};
  const artifactsWindow = await safeQuery(
    "artifacts_window",
    "SELECT artifact_type, COUNT(*) as count FROM intel_artifacts WHERE created_at >= to_timestamp($1/1000.0) GROUP BY artifact_type",
    [since]
  );
  last24h.artifacts = artifactsWindow?.rows ?? [];
  const runsWindow = await safeQuery(
    "runs_window",
    "SELECT kind, COUNT(*) as count FROM intel_runs WHERE started_at >= to_timestamp($1/1000.0) GROUP BY kind",
    [since]
  );
  last24h.runs = runsWindow?.rows ?? [];
  const eventsWindow = await safeQuery(
    "events_window",
    "SELECT type, COUNT(*) as count FROM intel_events WHERE ts >= $1 GROUP BY type",
    [since]
  );
  last24h.events = eventsWindow?.rows ?? [];

  // health hints
  const queuedJobs = tables?.jobs?.grouped?.filter((g: any) => g.status === "queued") ?? [];
  const totalQueued = queuedJobs.reduce((a: number, b: any) => a + Number(b?.count ?? 0), 0);
  const orchestrateRecent =
    tables?.intel_runs?.lastOrchestrateAt && new Date(tables.intel_runs.lastOrchestrateAt).getTime() >= nowTs - 30 * 60 * 1000;

  let lastSignalsAnyAt: number | null = null;
  try {
    const res = await pool.query(
      `
        SELECT MAX(ts) as last_ts FROM (
          SELECT MAX(started_at) as ts FROM intel_runs WHERE kind IN ('signals_run','signals_events_chat')
          UNION ALL
          SELECT MAX(created_at) as ts FROM intel_artifacts WHERE artifact_type IN ('signals_events_snapshot','signals_events_chat_snapshot')
        ) t
      `
    );
    const rawTs = res.rows?.[0]?.last_ts ? new Date(res.rows[0].last_ts).getTime() : null;
    lastSignalsAnyAt = rawTs ?? null;
  } catch (err) {
    warnings.push("signals_last_ts_error");
  }

  const signalsRecent = lastSignalsAnyAt !== null && lastSignalsAnyAt >= nowTs - Math.min(hours, 2) * 60 * 60 * 1000;
  const healthHints = {
    jobsDraining: totalQueued === 0,
    orchestrateRunningRecently: !!orchestrateRecent,
    signalsRunningRecently: !!signalsRecent,
  };

  res.json({ nowTs, tables, last24h, healthHints, lastSignalsAnyAt, warnings });
});
