import axios from "axios";
import { orchestrateRun, OrchestratorState, readOrchestratorState, writeOrchestratorState } from "./orchestratorService.js";
import { schedulerConfig } from "./schedulerConfig.js";
import { claimJobs, completeJob, failJob } from "./jobQueue.js";
import { runDailyMetricsForChat } from "./metricsDailyService.js";
import { callLLM } from "../llm.js";
import { buildSignalsEventsPrompt, SignalsChat } from "../prompts.js";
import { fetchChatMessagesBefore, fetchServiceStatus, getCoverageStatus } from "../whatsappClient.js";
import { startRun, saveArtifact, finishRun, saveEvents } from "./intelPersistence.js";

type InfillResult = { complete: boolean; reason: "coverageOk" | "fallbackOk" | "notReady"; seedExists: boolean; coverageOk: boolean; fallbackOk: boolean };

const started = { value: false };
let tickSeq = 0;

const serviceBClient = axios.create({
  baseURL: schedulerConfig.serviceBBase,
  timeout: 60_000,
});

if (schedulerConfig.apiKey) {
  serviceBClient.defaults.headers.common["Authorization"] = `Bearer ${schedulerConfig.apiKey}`;
}

function pushError(state: OrchestratorState, message: string) {
  const arr = state.lastErrors ?? [];
  arr.push({ ts: Date.now(), message });
  while (arr.length > 20) arr.shift();
  state.lastErrors = arr;
}

function getOffsetMinutes(tz: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "UTC";
  const match = tzName.match(/([+-])(\d{2})(?::?(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? 0);
  const mins = Number(match[3] ?? 0);
  return sign * (hours * 60 + mins);
}

function getTzNow(tz: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const offsetMinutes = getOffsetMinutes(tz, new Date());
  return { year, month, day, hour, minute, dateStr: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, offsetMinutes };
}

function dailyDueTs(tz: string, hour: number, minute: number, lastRunDate?: string | null) {
  const nowParts = getTzNow(tz);
  const todayTs = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, hour, minute) - nowParts.offsetMinutes * 60_000;
  const nowTs = Date.now();
  const todayStr = nowParts.dateStr;
  if (lastRunDate === todayStr) {
    // already ran today
    return todayTs + 24 * 60 * 60 * 1000;
  }
  if (nowTs <= todayTs) return todayTs;
  // schedule for next day
  const nextDate = new Date(todayTs + 24 * 60 * 60 * 1000);
  const nextParts = getTzNow(tz);
  const target = Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth(), nextDate.getUTCDate(), hour, minute) - nextParts.offsetMinutes * 60_000;
  return target;
}

export function isInitialInfillComplete(coverage: any, state: OrchestratorState, now: number): InfillResult {
  const seedExists = Number(coverage?.directChatsTotal ?? 0) >= schedulerConfig.minDirectChats;
  const coverageOk = Number(coverage?.directCoveragePct ?? 0) >= schedulerConfig.minDirectCoveragePct;
  const fallbackOk =
    !!state.serviceAFirstSeenAt && now - state.serviceAFirstSeenAt >= schedulerConfig.coverageFallbackAfterMs;
  const complete = seedExists && (coverageOk || fallbackOk);
  let reason: InfillResult["reason"] = "notReady";
  if (complete && coverageOk) reason = "coverageOk";
  else if (complete && fallbackOk) reason = "fallbackOk";
  return { complete, reason, seedExists, coverageOk, fallbackOk };
}

async function callServiceB(path: string, params?: Record<string, any>) {
  try {
    return await serviceBClient.post(path, null, { params });
  } catch (err: any) {
    if (err?.code === "ECONNABORTED" || /timeout/i.test(err?.message ?? "")) {
      console.warn(`[orch] Service B call timeout tick=${tickSeq} path=${path}`);
    }
    throw err;
  }
}

function parseWindows(raw: any): number[] {
  if (!raw) return [1, 7, 30];
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase().replace("d", ""))
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length ? parts : [1, 7, 30];
}

async function processMetricsJob(job: any) {
  const payload = job?.payload ?? {};
  const chatId = payload?.chatId;
  if (!chatId) throw new Error("missing chatId");
  const windows = parseWindows(payload?.windows);
  const runId = await startRun({
    kind: "metrics_daily_chat",
    runType: "job",
    params: payload,
  });
  try {
    const result = await runDailyMetricsForChat(chatId, { windows, limitPerChat: 500 });
    await saveArtifact({ runId, artifactType: "metrics_daily_chat_snapshot", chatId, payload: result });
    await finishRun(runId, { status: "ok" });
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    throw err;
  }
}

async function processSignalsJob(job: any) {
  const payload = job?.payload ?? {};
  const chatId = payload?.chatId;
  const hours = Number(payload?.hours ?? 72);
  if (!chatId) throw new Error("missing chatId");
  const runId = await startRun({
    kind: "signals_events_chat",
    runType: "job",
    params: payload,
  });
  const nowTs = Date.now();
  const cutoffTs = nowTs - hours * 60 * 60 * 1000;
  try {
    const { messages } = await fetchChatMessagesBefore(chatId, nowTs, 50).catch(() => ({ messages: [] as any[] }));
    const minInputMsgTs = messages.reduce((m: number | null, msg: any) => (m === null ? msg.ts : Math.min(m, msg.ts)), null);
    const maxInputMsgTs = messages.reduce((m: number | null, msg: any) => (m === null ? msg.ts : Math.max(m, msg.ts)), null);
    const chatSlice: SignalsChat = {
      chatId,
      messageCount: messages.length,
      messages: messages
        .sort((a: any, b: any) => a.ts - b.ts)
        .map((m: any) => ({
          ts: m.ts,
          fromMe: m.fromMe,
          body: m.body,
          type: m.type,
        })),
    };
    const prompt = buildSignalsEventsPrompt({ windowHours: hours, generatedAtTs: nowTs, maxEvents: 50, chats: [chatSlice] });
    const llmResp = await callLLM<any>("signals", prompt);
    const responsePayload: any = llmResp ?? {};
    responsePayload.generatedAtTs = nowTs;
    responsePayload.windowHours = hours;
    responsePayload.nowTs = nowTs;
    responsePayload.cutoffTs = cutoffTs;
    responsePayload.minInputMsgTs = minInputMsgTs;
    responsePayload.maxInputMsgTs = maxInputMsgTs;

    const globalMaxTs = maxInputMsgTs ?? null;
    if (Array.isArray(responsePayload.events)) {
      responsePayload.events = responsePayload.events
        .map((e: any) => {
          const coercedTs = Number(e?.ts);
          const isTsValid = Number.isFinite(coercedTs) && coercedTs >= cutoffTs && coercedTs <= nowTs + 5 * 60 * 1000;
          const finalTs = isTsValid ? coercedTs : globalMaxTs;
          return { ...e, ts: finalTs ?? null };
        })
        .sort((a: any, b: any) => (b?.ts ?? 0) - (a?.ts ?? 0))
        .slice(0, 50);
    }

    await saveArtifact({ runId, artifactType: "signals_events_chat_snapshot", chatId, payload: responsePayload });
    await saveEvents(
      runId,
      Array.isArray(responsePayload.events)
        ? responsePayload.events.map((e: any) => ({
            ts: e?.ts,
            chatId: e?.chatId ?? chatId,
            type: e?.type,
            direction: e?.direction,
            confidence: e?.confidence,
          }))
        : []
    );
    await finishRun(runId, { status: "ok" });
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    throw err;
  }
}

async function processJob(job: any) {
  const type = job?.type;
  if (type === "metrics_daily_chat") {
    await processMetricsJob(job);
  } else if (type === "signals_events_chat") {
    await processSignalsJob(job);
  } else {
    // unsupported: mark done
    await completeJob(job.id);
  }
}

function shouldRunOrchestrate(state: OrchestratorState, seedExists: boolean, now: number) {
  if (!seedExists) return false;
  const last = state.lastOrchestrateAt ?? 0;
  return now - last >= schedulerConfig.orchestrateMinIntervalMs;
}

function shouldRunOpenLoops(state: OrchestratorState, now: number) {
  const last = state.lastOpenLoopsAt ?? 0;
  return now - last >= schedulerConfig.openLoopsMinIntervalMs;
}

function shouldRunDaily(state: OrchestratorState, now: number) {
  const next = dailyDueTs(schedulerConfig.tz, schedulerConfig.dailyMetricsHour, schedulerConfig.dailyMetricsMinute, state.lastDailyMetricsRunDate);
  return now >= next;
}

async function tick() {
  const tickId = ++tickSeq;
  const now = Date.now();
  const state = readOrchestratorState();
  state.lastTickAt = now;
  state.lastTickId = tickId;

  // 1) Readiness check via /status
  let statusJson: any = null;
  let reachable = false;
  let ready = false;
  let needsQr = false;
  let stateStr: string | null = null;
  let readyReason: string | null = null;
  try {
    statusJson = await fetchServiceStatus();
    reachable = true;
    needsQr = statusJson?.needsQr === true;
    stateStr = statusJson?.state ?? statusJson?.clientState ?? null;
    ready = !needsQr && stateStr === "connected";
    if (!ready) {
      if (needsQr) readyReason = "needs_qr";
      else if (stateStr && stateStr !== "connected") readyReason = "state_not_connected";
      else if (stateStr === null) readyReason = "unknown_state_key";
    } else {
      readyReason = "connected";
    }
  } catch (err: any) {
    reachable = false;
    ready = false;
    readyReason = "unreachable";
    statusJson = { error: err?.message ?? "unreachable" };
  }

  const prevReady = state.serviceAReady;
  state.serviceAReachable = reachable;
  state.serviceAReady = ready;
  state.serviceAReadyReason = readyReason;
  state.serviceAState = stateStr;
  state.serviceANeedsQr = needsQr;
  state.serviceALastStatus = statusJson;
  state.serviceAStatusCheckedAt = now;
  if (ready && !state.serviceAReadyAt) state.serviceAReadyAt = now;
  writeOrchestratorState(state);

  if (prevReady !== ready) {
    console.info(`[orch tick=${tickId}] readiness changed`, { reachable, ready, reason: readyReason });
  }

  if (!reachable || !ready) {
    return;
  }

  let coverage: any = null;
  try {
    coverage = await getCoverageStatus();
    state.lastCoverage = coverage;
    state.lastServiceACheck = coverage;
    if (Number(coverage?.directChatsTotal ?? 0) > 0 && !state.serviceAFirstSeenAt) {
      state.serviceAFirstSeenAt = now;
    }
  } catch (err: any) {
    const message = err?.message ?? "coverage_unreachable";
    pushError(state, message);
    writeOrchestratorState(state);
    console.warn("[scheduler] coverage check failed; skipping tick", message);
    return;
  }

  const infill = isInitialInfillComplete(coverage, state, now);

  // Orchestrate (backfill targets)
  if (shouldRunOrchestrate(state, infill.seedExists, now)) {
    try {
      await callServiceB("/intel/orchestrate/run", { runType: "scheduled" });
      state.lastOrchestrateAt = now;
      console.info(`[orch tick=${tickId}] ran orchestrate`);
    } catch (err: any) {
      pushError(state, err?.message ?? "orchestrate_failed");
      console.warn(`[orch tick=${tickId}] orchestrate failed`, err?.message ?? err);
    }
  } else if (!infill.seedExists) {
    console.info(`[orch tick=${tickId}] skip orchestrate (no seed)`);
  }

  // Open loops refresh
  if (shouldRunOpenLoops(state, now)) {
    try {
      await callServiceB("/open-loops/refresh", { hours: 6, runType: "scheduled" });
      state.lastOpenLoopsAt = now;
      console.info(`[orch tick=${tickId}] ran open loops refresh`);
    } catch (err: any) {
      pushError(state, err?.message ?? "open_loops_failed");
      console.warn(`[orch tick=${tickId}] open loops refresh failed`, err?.message ?? err);
    }
  }

  // Daily metrics (time-of-day + daily)
  if (infill.complete && shouldRunDaily(state, now)) {
    const tzNow = getTzNow(schedulerConfig.tz);
    const todayStr = tzNow.dateStr;
    try {
      await callServiceB("/intel/metrics/time-of-day/run", { includeGroups: false, activeOnly: true });
      await callServiceB("/intel/metrics/daily/run", { includeGroups: false, windows: "1,7,30", activeOnly: true });
      state.lastDailyMetricsRunDate = todayStr;
      state.lastTimeOfDayRunDate = todayStr;
      console.info(`[orch tick=${tickId}] ran daily metrics`);
    } catch (err: any) {
      pushError(state, err?.message ?? "daily_metrics_failed");
      console.warn(`[orch tick=${tickId}] daily metrics failed`, err?.message ?? err);
    }
  }

  writeOrchestratorState(state);

  if (schedulerConfig.jobWorkerEnabled) {
    try {
      const jobs = await claimJobs(schedulerConfig.jobWorkerLimit);
      if (jobs.length) console.info(`[job worker] claimed ${jobs.length}`);
      for (const job of jobs) {
        const chatId = job?.chat_id ?? job?.chatId ?? job?.payload?.chatId ?? null;
        console.info(`[job worker] processing id=${job?.id} type=${job?.type} chatId=${chatId ?? "n/a"}`);
        try {
          await processJob(job);
          await completeJob(job.id);
          console.info(`[job worker] completed id=${job?.id}`);
        } catch (err: any) {
          await failJob(job.id, err?.message ?? String(err));
          console.warn(`[job worker] failed id=${job?.id} err=${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      console.warn("[job worker] tick error", err?.message ?? err);
    }
  }
}

export function getSchedulerStatus(state: OrchestratorState, coverage: any, now: number) {
  const infill = isInitialInfillComplete(coverage, state, now);
  const nextOrchestrate = (state.lastOrchestrateAt ?? 0) + schedulerConfig.orchestrateMinIntervalMs;
  const nextOpenLoops = (state.lastOpenLoopsAt ?? 0) + schedulerConfig.openLoopsMinIntervalMs;
  const nextDaily = dailyDueTs(schedulerConfig.tz, schedulerConfig.dailyMetricsHour, schedulerConfig.dailyMetricsMinute, state.lastDailyMetricsRunDate);
  return {
    enabled: schedulerConfig.enabled,
    tickMs: schedulerConfig.tickMs,
    infillComplete: infill.complete,
    infillReason: infill.reason,
    nextDue: {
      orchestrate: nextOrchestrate,
      openLoops: nextOpenLoops,
      dailyMetrics: nextDaily,
      timeOfDay: nextDaily,
    },
    lastRuns: {
      orchestrate: state.lastOrchestrateAt ?? null,
      openLoops: state.lastOpenLoopsAt ?? null,
      dailyMetricsDate: state.lastDailyMetricsRunDate ?? null,
      timeOfDayDate: state.lastTimeOfDayRunDate ?? null,
    },
    lastTickAt: state.lastTickAt ?? null,
    lastErrors: state.lastErrors ?? [],
  };
}

export function startOrchestratorScheduler() {
  if (started.value) return;
  started.value = true;
  if (!schedulerConfig.enabled) {
    console.info("[scheduler] disabled via ORCH_ENABLED");
    return;
  }
  setTimeout(() => tick().catch(() => {}), 100); // initial kick
  setInterval(() => {
    tick().catch((err) => {
      const state = readOrchestratorState();
      pushError(state, err?.message ?? "tick_failed");
      writeOrchestratorState(state);
      console.warn("[scheduler] tick failed", err?.message ?? err);
    });
  }, schedulerConfig.tickMs);
}
