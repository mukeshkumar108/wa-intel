import fs from "fs";
import path from "path";
import { getCoverageStatus, setBackfillTargets, CoverageStatus, fetchActiveChats, fetchChatMessagesBefore, fetchServiceStatus } from "../whatsappClient.js";
import type { MessageRecord } from "../types.js";
import { callLLM } from "../llm.js";
import { buildOrchestratorHeatPrompt, OrchestratorHeatChatSlice } from "../prompts.js";
import { schedulerConfig } from "./schedulerConfig.js";
import {
  getRecentHighSignalChatIds,
  getLastBackfillPostedByChatIds,
  saveBackfillPosts,
  getBackfillPostedEvidence,
} from "./intelPersistence.js";

export type OrchestratorState = {
  lastRunAt?: number;
  lastRunType?: string;
  lastResult?: any;
  lastCoverage?: CoverageStatus;
  targets?: Record<string, number>;
  lastTargetsPostedAt?: number;
  lastCheckedAt?: number;
  serviceAFirstSeenAt?: number;
  lastOrchestrateAt?: number;
  lastOpenLoopsAt?: number;
  lastDailyMetricsRunDate?: string;
  lastTimeOfDayRunDate?: string;
  lastServiceACheck?: any;
  lastErrors?: { ts: number; message: string }[];
  lastTickAt?: number;
  lastTickId?: number;
  serviceAReachable?: boolean;
  serviceAReady?: boolean;
  serviceAReadyReason?: string | null;
  serviceAState?: string | null;
  serviceANeedsQr?: boolean;
  serviceALastStatus?: any;
  serviceAStatusCheckedAt?: number;
  serviceAReadyAt?: number;
};

const OUT_DIR = path.join(process.cwd(), "out", "intel");
const STATE_PATH = path.join(OUT_DIR, "orchestrator_state.json");
const RUNS_PATH = path.join(OUT_DIR, "orchestrator_runs.jsonl");
const HEAT_LATEST_PATH = path.join(OUT_DIR, "heat_latest.json");
const HEAT_RUNS_PATH = path.join(OUT_DIR, "heat_runs.jsonl");
const MIN_DIRECT_COVERAGE_PCT = Number(process.env.ORCH_MIN_DIRECT_COVERAGE_PCT ?? process.env.MIN_DIRECT_COVERAGE_PCT ?? 70);
const ORCH_HIGH_TARGET = Number(process.env.ORCH_HIGH_TARGET ?? 300);
const ORCH_MED_TARGET = Number(process.env.ORCH_MED_TARGET ?? 150);
const ORCH_MAX_TARGET = Number(process.env.ORCH_MAX_TARGET ?? 500);
const ORCH_EVENT_PRIORITY_ENABLED = String(process.env.ORCH_EVENT_PRIORITY_ENABLED ?? "true").toLowerCase() === "true";
const ORCH_EVENT_PRIORITY_HOURS = Number(process.env.ORCH_EVENT_PRIORITY_HOURS ?? 72);
const ORCH_EVENT_PRIORITY_MAX_CHATS = Number(process.env.ORCH_EVENT_PRIORITY_MAX_CHATS ?? 20);
const ORCH_EVENT_PRIORITY_TYPES = (process.env.ORCH_EVENT_PRIORITY_TYPES ?? "sexual_flirt,secrecy_concealment,meetup_plan")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ORCH_MIN_STARTUP_MESSAGES = Number(process.env.ORCH_MIN_STARTUP_MESSAGES ?? 0);
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const parsedCooldown = Number(process.env.ORCH_TARGET_COOLDOWN_MS ?? DEFAULT_COOLDOWN_MS);
const ORCH_TARGET_COOLDOWN_MS = Number.isFinite(parsedCooldown) && parsedCooldown >= 0 ? parsedCooldown : DEFAULT_COOLDOWN_MS;

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
    return todayTs + 24 * 60 * 60 * 1000;
  }
  if (nowTs <= todayTs) return todayTs;
  const nextDate = new Date(todayTs + 24 * 60 * 60 * 1000);
  const nextOffset = getOffsetMinutes(tz, nextDate);
  const year = nextDate.getUTCFullYear();
  const month = nextDate.getUTCMonth();
  const day = nextDate.getUTCDate();
  return Date.UTC(year, month, day, hour, minute) - nextOffset * 60_000;
}

export function buildSchedulerStatus(state: OrchestratorState, coverage: CoverageStatus | undefined, now: number) {
  const reachable = state.serviceAReachable === true;
  const connected = reachable && state.serviceAReady === true;
  const startupStatus = state.serviceALastStatus?.startupInfillStatus ?? null;
  let infillComplete = false;
  let infillReason:
    | "service_a_unreachable"
    | "service_a_not_connected"
    | "startup_done"
    | "startup_failed_proceed"
    | "startup_not_done" = "startup_not_done";

  if (!reachable) {
    infillComplete = false;
    infillReason = "service_a_unreachable";
  } else if (!connected) {
    infillComplete = false;
    infillReason = "service_a_not_connected";
  } else if (startupStatus === "done") {
    infillComplete = true;
    infillReason = "startup_done";
  } else if (startupStatus === "failed") {
    infillComplete = true;
    infillReason = "startup_failed_proceed";
  } else {
    infillComplete = false;
    infillReason = "startup_not_done";
  }

  const nextOrchestrate = (state.lastOrchestrateAt ?? 0) + schedulerConfig.orchestrateMinIntervalMs;
  const nextOpenLoops = (state.lastOpenLoopsAt ?? 0) + schedulerConfig.openLoopsMinIntervalMs;
  const nextDaily = dailyDueTs(
    schedulerConfig.tz,
    schedulerConfig.dailyMetricsHour,
    schedulerConfig.dailyMetricsMinute,
    state.lastDailyMetricsRunDate
  );

  return {
    enabled: schedulerConfig.enabled,
    tickMs: schedulerConfig.tickMs,
    infillComplete,
    infillReason,
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
    tickId: state.lastTickId ?? null,
    lastErrors: state.lastErrors ?? [],
    serviceA: {
      reachable: state.serviceAReachable ?? null,
      ready: state.serviceAReady ?? null,
      readyReason: state.serviceAReadyReason ?? null,
      state: state.serviceAState ?? null,
      needsQr: state.serviceANeedsQr ?? null,
      readyAt: state.serviceAReadyAt ?? null,
      statusCheckedAt: state.serviceAStatusCheckedAt ?? null,
    },
  };
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

export function readOrchestratorState(): OrchestratorState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    return JSON.parse(raw) as OrchestratorState;
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[orchestrator] read state failed", err);
    return {};
  }
}

export function writeOrchestratorState(state: OrchestratorState) {
  ensureOutDir();
  const tmpPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, STATE_PATH);
}

function appendRun(entry: any) {
  ensureOutDir();
  fs.appendFileSync(RUNS_PATH, JSON.stringify(entry) + "\n");
}

function appendHeatRun(entry: any) {
  ensureOutDir();
  fs.appendFileSync(HEAT_RUNS_PATH, JSON.stringify(entry) + "\n");
}

function computeTargets(coverage?: CoverageStatus): { chatId: string; targetMessages: number }[] {
  const top = Array.isArray(coverage?.topChats) ? coverage.topChats : [];
  const targets = top
    .map((c) => ({
      chatId: c.chatId,
      targetMessages: Number(c.targetMessages ?? 0),
    }))
    .filter((t) => t.chatId && Number.isFinite(t.targetMessages) && t.targetMessages > 0);
  return targets;
}

export async function orchestrateStatus() {
  const state = readOrchestratorState();
  const now = Date.now();
  let coverageStatus: CoverageStatus | undefined;
  let error: string | undefined;

  try {
    coverageStatus = await getCoverageStatus();
    state.lastCoverage = coverageStatus;
    state.lastCheckedAt = now;
    state.lastServiceACheck = coverageStatus;
    writeOrchestratorState(state);
  } catch (err: any) {
    error = err?.message ?? "unknown_error";
    state.lastServiceACheck = { error };
    writeOrchestratorState(state);
  }

  return {
    nowTs: now,
    serviceA: {
      ok: !error,
      coverageStatus,
      lastCheckedAt: state.lastCheckedAt ?? now,
      error,
    },
    thresholds: { minDirectCoveragePct: MIN_DIRECT_COVERAGE_PCT },
    stateSummary: {
      lastRunAt: state.lastRunAt ?? null,
      lastRunResult: state.lastResult ?? null,
      pendingTargetsCount: Object.keys(state.targets ?? {}).length,
      lastTargetsPostedAt: state.lastTargetsPostedAt ?? null,
    },
    scheduler: buildSchedulerStatus(state, coverageStatus ?? state.lastCoverage, now),
  };
}

export async function orchestrateRun(opts: { force?: boolean; runType?: string; limitChats?: number; limitPerChat?: number; debug?: boolean }) {
  const { force = false, runType = "manual", limitChats = 50, limitPerChat = 30, debug = false } = opts;
  const now = Date.now();
  const state = readOrchestratorState();
  const eventPriority = {
    enabled: ORCH_EVENT_PRIORITY_ENABLED,
    hours: ORCH_EVENT_PRIORITY_HOURS,
    maxChats: ORCH_EVENT_PRIORITY_MAX_CHATS,
    types: ORCH_EVENT_PRIORITY_TYPES,
    selectedCount: 0,
    selectedChatIdsPreview: [] as string[],
  };

  // Service A status gate
  let statusJson: any = null;
  let statusError: any = null;
  try {
    statusJson = await fetchServiceStatus();
  } catch (err) {
    statusError = err;
  }
  const stateStr = statusJson?.state ?? statusJson?.clientState ?? null;
  const needsQr = statusJson?.needsQr === true;
  const connected = statusError ? false : stateStr === "connected" && !needsQr;
  const startupInfillStatus = statusJson?.startupInfillStatus ?? null;
  const startupInfillFetchedMessages = Number(statusJson?.startupInfillFetchedMessages ?? 0);
  const startupInfillFetchedChats = Number(statusJson?.startupInfillFetchedChats ?? 0);
  const startupInfillError = statusJson?.startupInfillError ?? null;
  const startupInfillStartedAt = statusJson?.startupInfillStartedAt ?? null;
  const startupInfillFinishedAt = statusJson?.startupInfillFinishedAt ?? null;

  const serviceAInfo = {
    state: stateStr,
    needsQr,
    startupInfillStatus,
    startupInfillStartedAt,
    startupInfillFinishedAt,
    startupInfillFetchedChats,
    startupInfillFetchedMessages,
    startupInfillError,
  };

  if (!connected) {
    const result = {
      skipped: "service_a_not_connected",
      serviceA: serviceAInfo,
      eventPriority,
      targetsPlanned: 0,
      targetsPosted: 0,
      postedMode: "none",
    };
    appendRun({ ts: now, runType, result, serviceA: serviceAInfo });
    return result;
  }

  let startupWarning = false;
  if (startupInfillStatus !== "done") {
    if (startupInfillStatus === "failed") {
      startupWarning = true;
    } else if (!force) {
      const result = {
        skipped: "startup_infill_not_done",
        serviceA: serviceAInfo,
        eventPriority,
        targetsPlanned: 0,
        targetsPosted: 0,
        postedMode: "none",
      };
      appendRun({ ts: now, runType, result, serviceA: serviceAInfo });
      return result;
    }
  }

  if (!startupWarning && ORCH_MIN_STARTUP_MESSAGES > 0 && startupInfillFetchedMessages < ORCH_MIN_STARTUP_MESSAGES && !force) {
    const result = {
      skipped: "startup_infill_not_done",
      serviceA: serviceAInfo,
      eventPriority,
      targetsPlanned: 0,
      targetsPosted: 0,
      postedMode: "none",
    };
    appendRun({ ts: now, runType, result, serviceA: serviceAInfo });
    return result;
  }

  let coverage: CoverageStatus | undefined;
  try {
    coverage = await getCoverageStatus();
    state.lastCoverage = coverage;
    state.lastCheckedAt = now;
  } catch (err: any) {
    // non-fatal; proceed with whatever data we have
    console.error("[orchestrator] coverage_fetch_failed", err);
  }

  const coverageTargets = computeTargets(coverage);
  const coverageTargetMap = new Map<string, number>();
  for (const t of coverageTargets) coverageTargetMap.set(t.chatId, t.targetMessages);
  const debugPosting = debug
    ? {
        attempted: false,
        payloadPreview: null as any,
        serviceAResponsePreview: null as any,
        error: null as string | null,
        postedChatIds: [] as string[],
      }
    : null;

  // Build chat slices for LLM triage
  const activeChats = await fetchActiveChats(limitChats, false);
  const filteredChats = activeChats.filter((c) => c.chatId !== "status@broadcast" && !c.chatId.endsWith("@g.us") && !c.isGroup);
  const chatSlices: OrchestratorHeatChatSlice[] = [];
  for (const chat of filteredChats) {
    const { messages } = await fetchChatMessagesBefore(chat.chatId, 0, limitPerChat).catch(() => ({ messages: [] as MessageRecord[] }));
    chatSlices.push({
      chatId: chat.chatId,
      chatDisplayName: chat.displayName ?? chat.chatId,
      messages: messages
        .sort((a, b) => a.ts - b.ts)
        .map((m) => ({
          speaker: m.fromMe ? "ME" : "OTHER",
          type: m.type,
          body: m.body === null || m.body === undefined || m.body === "" ? `[media:${m.type}]` : m.body,
          ts: m.ts,
        })),
    });
  }

  let llmResp: any = null;
  try {
    llmResp = await callLLM<any>("heatTriage", buildOrchestratorHeatPrompt(chatSlices));
  } catch (err: any) {
    const result = { ok: false, error: err?.message ?? "heat_triage_failed" };
    state.lastRunAt = now;
    state.lastRunType = runType;
    state.lastResult = result;
    state.lastOrchestrateAt = now;
    writeOrchestratorState(state);
    appendRun({ ts: now, runType, result, coverage, params: { limitChats, limitPerChat } });
    return result;
  }

  const heatResults: {
    chatId: string;
    heatTier: "LOW" | "MED" | "HIGH";
    heatScore: number;
    reasons: string[];
  }[] = Array.isArray(llmResp?.results) ? llmResp.results : [];
  const maxTargetFromCoverage = Number((coverage as any)?.maxTargetMessages ?? ORCH_MAX_TARGET);

  const plannedTargets: { chatId: string; targetMessages: number }[] = [];
  for (const r of heatResults) {
    const tier = r?.heatTier;
    let target = 0;
    if (tier === "HIGH") target = ORCH_HIGH_TARGET;
    else if (tier === "MED") target = ORCH_MED_TARGET;
    if (target > 0) {
      target = Math.min(target, maxTargetFromCoverage);
      plannedTargets.push({ chatId: r.chatId, targetMessages: target });
    }
  }

  // Event-driven prioritization
  let eventPrioritySelected: string[] = [];
  if (ORCH_EVENT_PRIORITY_ENABLED && ORCH_EVENT_PRIORITY_TYPES.length && ORCH_EVENT_PRIORITY_MAX_CHATS > 0) {
    try {
      eventPrioritySelected = await getRecentHighSignalChatIds({
        hours: ORCH_EVENT_PRIORITY_HOURS,
        types: ORCH_EVENT_PRIORITY_TYPES,
        limit: ORCH_EVENT_PRIORITY_MAX_CHATS,
      });
    } catch (err) {
      console.error("[orchestrator] event priority query failed", err);
    }
  }

  if (eventPrioritySelected.length) {
    for (const chatId of eventPrioritySelected.reverse()) {
      const alreadyPlanned = plannedTargets.find((t) => t.chatId === chatId);
      if (alreadyPlanned) continue;
      plannedTargets.unshift({ chatId, targetMessages: ORCH_HIGH_TARGET });
    }
  }
  eventPriority.selectedCount = eventPrioritySelected.length;
  eventPriority.selectedChatIdsPreview = eventPrioritySelected.slice(0, 5);

  const plannedChatIds = Array.from(new Set(plannedTargets.map((t) => t.chatId)));
  let lastPostedMap: Record<string, number> = {};
  try {
    if (plannedChatIds.length) {
      lastPostedMap = await getLastBackfillPostedByChatIds(plannedChatIds);
    }
  } catch (err) {
    console.error("[orchestrator] last posted map fetch failed", err);
  }
  const existingMap = new Map(Object.entries(state.targets ?? {}).map(([k, v]) => [k, Number(v ?? 0)]));
  const heatMap = new Map(heatResults.map((h) => [h.chatId, h]));
  const dropReasons: Record<string, number> = {
    missingTargetMessages: 0,
    cooldown_active: 0,
    missing_satisfaction_reason: 0,
  };
  const targetDecisions = plannedChatIds.map((chatId) => {
    const plannedTarget = plannedTargets.find((t) => t.chatId === chatId);
    const targetMessages = plannedTarget?.targetMessages ?? coverageTargetMap.get(chatId) ?? null;
    const heat = heatMap.get(chatId);
    let satisfaction: { satisfied: boolean; reason: string | null; evidence?: any } = {
      satisfied: false,
      reason: null,
      evidence: null,
    };
    if (!Number.isFinite(targetMessages) || (targetMessages ?? 0) <= 0) {
      dropReasons.missingTargetMessages++;
    } else {
      const lastPostedAt = lastPostedMap[chatId] ?? null;
      const ageMs = lastPostedAt != null ? now - lastPostedAt : null;
      if (lastPostedAt != null && ageMs != null && ageMs < ORCH_TARGET_COOLDOWN_MS) {
        satisfaction = {
          satisfied: true,
          reason: "cooldown_active",
          evidence: {
            lastPostedAt,
            ageMs,
            cooldownMs: ORCH_TARGET_COOLDOWN_MS,
            cooldownRemainingMs: Math.max(0, ORCH_TARGET_COOLDOWN_MS - ageMs),
          },
        };
        dropReasons.cooldown_active++;
      }
    }
    const lastPostedAt = lastPostedMap[chatId] ?? null;
    const ageMs = lastPostedAt != null ? now - lastPostedAt : null;
    const cooldownRemainingMs = ageMs != null ? Math.max(0, ORCH_TARGET_COOLDOWN_MS - ageMs) : null;
    return {
      chatId,
      planned: !!plannedTarget,
      posted: false,
      skippedReason: satisfaction.satisfied ? "already_satisfied" : undefined,
      signals: heat
        ? { heatTier: heat.heatTier, heatScore: heat.heatScore, eventPriority: eventPrioritySelected.includes(chatId) }
        : { heatTier: null, heatScore: null, eventPriority: eventPrioritySelected.includes(chatId) },
      satisfaction: {
        satisfied: satisfaction.satisfied,
        reason: satisfaction.reason,
        evidence: satisfaction.evidence ?? null,
      },
      coverage: {
        messageCountKnown: null,
        baselineTarget: targetMessages,
      },
      lastPostedAt,
      cooldownMs: ORCH_TARGET_COOLDOWN_MS,
      cooldownRemainingMs,
    };
  });

  const postCandidates = targetDecisions
    .filter((d) => d.planned && !d.satisfaction?.satisfied && Number.isFinite(d.coverage.baselineTarget) && (d.coverage.baselineTarget ?? 0) > 0)
    .map((d) => ({ chatId: d.chatId, targetMessages: Number(d.coverage.baselineTarget) }));
  const satisfiedCount = targetDecisions.filter((d) => d.satisfaction?.satisfied).length;
  const satisfactionReasonCounts: Record<string, number> = {};
  for (const d of targetDecisions) {
    const key = d.satisfaction?.reason ?? "not_satisfied";
    satisfactionReasonCounts[key] = (satisfactionReasonCounts[key] ?? 0) + 1;
    if (d.satisfaction?.satisfied && !d.satisfaction.reason) {
      dropReasons.missing_satisfaction_reason = (dropReasons.missing_satisfaction_reason ?? 0) + 1;
    }
  }
  const debugCompute = debug
    ? {
        plannedCount: targetDecisions.length,
        satisfiedCount,
        unsatisfiedCount: targetDecisions.length - satisfiedCount,
        plannedChatIdsPreview: targetDecisions.slice(0, 10).map((d) => d.chatId),
        unsatisfiedChatIdsPreview: targetDecisions.filter((d) => !d.satisfaction?.satisfied).slice(0, 10).map((d) => d.chatId),
        postCandidatesPreview: postCandidates.slice(0, 10),
        dropReasons,
        satisfactionReasonCounts,
        sampleSatisfaction: targetDecisions.slice(0, 10).map((d) => ({
          chatId: d.chatId,
          satisfied: d.satisfaction?.satisfied ?? false,
          reason: d.satisfaction?.reason ?? null,
          evidence: d.satisfaction?.evidence ?? null,
        })),
      }
    : null;

  let postedChatIds: string[] = [];
  try {
    if (postCandidates.length) {
      if (debugPosting) {
        debugPosting.attempted = true;
        debugPosting.payloadPreview = {
          targetsCount: postCandidates.length,
          first5: postCandidates.slice(0, 5),
        };
      }
      await setBackfillTargets(postCandidates);
      postedChatIds = postCandidates.map((t) => t.chatId);
      if (debugPosting) {
        debugPosting.serviceAResponsePreview = { ok: true };
        debugPosting.postedChatIds = postedChatIds;
      }
      await saveBackfillPosts(postedChatIds.map((chatId) => ({ chatId, ts: now })), null);
      const lastPostedMap = Object.fromEntries(postedChatIds.map((chatId) => [chatId, now]));
      (state as any).lastPostedMap = lastPostedMap;
      try {
        const evidence = await getLastBackfillPostedByChatIds(postedChatIds);
        const written = Object.keys(evidence).length;
        if (postedChatIds.length && written < postedChatIds.length) {
          console.error(
            "[orchestrator] invariant violated: missing backfill_target_posted rows",
            { expected: postedChatIds.length, found: written }
          );
        }
      } catch (err) {
        console.error("[orchestrator] invariant check failed", err);
      }
    } else if (debugPosting) {
      debugPosting.attempted = false;
    }
  } catch (err: any) {
    if (debugPosting) {
      debugPosting.error = err?.message ?? String(err);
    }
    const result = {
      ok: false,
      error: err?.message ?? "set_targets_failed",
      postedMode: "error",
      targetsPosted: 0,
      targetsPlanned: plannedTargets.length,
      eventPriority,
      serviceA: serviceAInfo,
    };
    state.lastRunAt = now;
    state.lastRunType = runType;
    state.lastResult = result;
    state.lastOrchestrateAt = now;
    writeOrchestratorState(state);
    appendRun({ ts: now, runType, result, coverage, targets: postCandidates, params: { limitChats, limitPerChat } });
    return result;
  }

  const postedSet = new Set(postedChatIds);
  for (const d of targetDecisions) {
    if (postedSet.has(d.chatId)) {
      d.posted = true;
      d.skippedReason = undefined;
      d.satisfaction = { satisfied: false, reason: null, evidence: null };
      d.lastPostedAt = now;
      d.cooldownRemainingMs = ORCH_TARGET_COOLDOWN_MS;
    }
  }

  const targetsPosted = postedChatIds.length;
  const postedMode = targetsPosted === 0 ? "none" : "full";
  const skippedAlreadySatisfied = targetDecisions.filter((d) => d.satisfaction?.satisfied).length;

  const result = {
    ok: true,
    chatsConsidered: chatSlices.length,
    targetsPlanned: plannedTargets.length,
    targetsPosted,
    skippedAlreadySatisfied,
    postedMode,
    top: heatResults.sort((a, b) => (b.heatScore ?? 0) - (a.heatScore ?? 0)).slice(0, 10),
    eventPriority,
    serviceA: serviceAInfo,
    serviceAStartupWarning: startupWarning,
  };
  if (debug) {
    (result as any).targetDecisions = targetDecisions;
    (result as any).debugPosting = debugPosting;
    (result as any).debugCompute = debugCompute;
    try {
      (result as any).debugPosting = {
        ...debugPosting,
        dbEvidence: await getBackfillPostedEvidence(),
      };
    } catch (err) {
      // best-effort only
    }
  }
  state.lastRunAt = now;
  state.lastRunType = runType;
  state.lastResult = result;
  state.lastOrchestrateAt = now;
  const postedTargetEntries = postCandidates
    .filter((t) => postedSet.has(t.chatId))
    .map((t) => [t.chatId, t.targetMessages] as [string, number]);
  state.targets = Object.fromEntries([...(state.targets ? Object.entries(state.targets) : []), ...postedTargetEntries]);
  writeOrchestratorState(state);
  appendRun({ ts: now, runType, result, coverage, targets: postCandidates, params: { limitChats, limitPerChat }, heatResults });
  appendHeatRun({
    ts: now,
    params: { limitChats, limitPerChat, runType },
    coverage,
    heatResults,
  });
  fs.writeFileSync(HEAT_LATEST_PATH, JSON.stringify({ ts: now, heatResults, params: { limitChats, limitPerChat } }, null, 2));

  return { ...result, targets: postCandidates };
}
