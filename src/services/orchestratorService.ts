import fs from "fs";
import path from "path";
import { getCoverageStatus, setBackfillTargets, CoverageStatus, fetchActiveChats, fetchChatMessagesBefore } from "../whatsappClient.js";
import type { MessageRecord } from "../types.js";
import { callLLM } from "../llm.js";
import { buildOrchestratorHeatPrompt, OrchestratorHeatChatSlice } from "../prompts.js";

type OrchestratorState = {
  lastRunAt?: number;
  lastRunType?: string;
  lastResult?: any;
  lastCoverage?: CoverageStatus;
  targets?: Record<string, number>;
  lastTargetsPostedAt?: number;
  lastCheckedAt?: number;
};

const OUT_DIR = path.join(process.cwd(), "out", "intel");
const STATE_PATH = path.join(OUT_DIR, "orchestrator_state.json");
const RUNS_PATH = path.join(OUT_DIR, "orchestrator_runs.jsonl");
const HEAT_LATEST_PATH = path.join(OUT_DIR, "heat_latest.json");
const HEAT_RUNS_PATH = path.join(OUT_DIR, "heat_runs.jsonl");
const MIN_DIRECT_COVERAGE_PCT = Number(process.env.MIN_DIRECT_COVERAGE_PCT ?? 70);
const ORCH_HIGH_TARGET = Number(process.env.ORCH_HIGH_TARGET ?? 300);
const ORCH_MED_TARGET = Number(process.env.ORCH_MED_TARGET ?? 150);
const ORCH_MAX_TARGET = Number(process.env.ORCH_MAX_TARGET ?? 500);

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function readState(): OrchestratorState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    return JSON.parse(raw) as OrchestratorState;
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[orchestrator] read state failed", err);
    return {};
  }
}

function writeState(state: OrchestratorState) {
  ensureOutDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function appendRun(entry: any) {
  ensureOutDir();
  fs.appendFileSync(RUNS_PATH, JSON.stringify(entry) + "\n");
}

function appendHeatRun(entry: any) {
  ensureOutDir();
  fs.appendFileSync(HEAT_RUNS_PATH, JSON.stringify(entry) + "\n");
}

function computeTargets(coverage: CoverageStatus): { chatId: string; targetMessages: number }[] {
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
  const state = readState();
  const now = Date.now();
  let coverageStatus: CoverageStatus | undefined;
  let error: string | undefined;

  try {
    coverageStatus = await getCoverageStatus();
    state.lastCoverage = coverageStatus;
    state.lastCheckedAt = now;
    writeState(state);
  } catch (err: any) {
    error = err?.message ?? "unknown_error";
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
  };
}

export async function orchestrateRun(opts: { force?: boolean; runType?: string; limitChats?: number; limitPerChat?: number }) {
  const { force = false, runType = "manual", limitChats = 50, limitPerChat = 30 } = opts;
  const now = Date.now();
  const state = readState();

  let coverage: CoverageStatus;
  try {
    coverage = await getCoverageStatus();
    state.lastCoverage = coverage;
    state.lastCheckedAt = now;
  } catch (err: any) {
    const result = { ok: false, error: err?.message ?? "coverage_fetch_failed" };
    state.lastRunAt = now;
    state.lastRunType = runType;
    state.lastResult = result;
    writeState(state);
    appendRun({ ts: now, runType, result });
    return result;
  }

  const directCoveragePct = Number(coverage?.directCoveragePct ?? 0);
  if (!force && directCoveragePct < MIN_DIRECT_COVERAGE_PCT) {
    const result = { skipped: "not_ready", directCoveragePct, minDirectCoveragePct: MIN_DIRECT_COVERAGE_PCT };
    state.lastRunAt = now;
    state.lastRunType = runType;
    state.lastResult = result;
    writeState(state);
    appendRun({ ts: now, runType, result, coverage });
    return result;
  }

  const coverageTargets = computeTargets(coverage);

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
    writeState(state);
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

  const dedupedTargets: { chatId: string; targetMessages: number }[] = [];
  let skippedAlreadySatisfied = 0;
  for (const t of plannedTargets) {
    const existing = state.targets?.[t.chatId] ?? 0;
    if (existing >= t.targetMessages) {
      skippedAlreadySatisfied++;
      continue;
    }
    dedupedTargets.push(t);
  }

  try {
    if (dedupedTargets.length) {
      await setBackfillTargets(dedupedTargets);
    }
  } catch (err: any) {
    const result = { ok: false, error: err?.message ?? "set_targets_failed", directCoveragePct };
    state.lastRunAt = now;
    state.lastRunType = runType;
    state.lastResult = result;
    writeState(state);
    appendRun({ ts: now, runType, result, coverage, targets: dedupedTargets, params: { limitChats, limitPerChat } });
    return result;
  }

  const targetsPosted = dedupedTargets.length;
  const result = {
    ok: true,
    chatsConsidered: chatSlices.length,
    targetsPlanned: plannedTargets.length,
    targetsPosted,
    skippedAlreadySatisfied,
    directCoveragePct,
    minDirectCoveragePct: MIN_DIRECT_COVERAGE_PCT,
    top: heatResults.sort((a, b) => (b.heatScore ?? 0) - (a.heatScore ?? 0)).slice(0, 10),
  };
  state.lastRunAt = now;
  state.lastRunType = runType;
  state.lastResult = result;
  state.targets = Object.fromEntries(
    [...(state.targets ? Object.entries(state.targets) : []), ...dedupedTargets.map((t) => [t.chatId, t.targetMessages])]
  );
  state.lastTargetsPostedAt = now;
  writeState(state);
  appendRun({ ts: now, runType, result, coverage, targets: dedupedTargets, params: { limitChats, limitPerChat }, heatResults });
  appendHeatRun({
    ts: now,
    params: { limitChats, limitPerChat, runType },
    coverage,
    heatResults,
  });
  fs.writeFileSync(HEAT_LATEST_PATH, JSON.stringify({ ts: now, heatResults, params: { limitChats, limitPerChat } }, null, 2));

  return { ...result, targets: dedupedTargets };
}
