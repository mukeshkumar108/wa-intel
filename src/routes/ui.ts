import { Router } from "express";
import fs from "fs";
import path from "path";
import { readOrchestratorState, buildSchedulerStatus } from "../services/orchestratorService.js";

export const uiRouter = Router();

function statInfo(p: string) {
  try {
    const s = fs.statSync(p);
    return { exists: true, mtimeMs: s.mtimeMs };
  } catch {
    return { exists: false, mtimeMs: null };
  }
}

uiRouter.get("/ui/status", async (_req, res) => {
  const now = Date.now();
  const state = readOrchestratorState();
  const serviceAReady = state.serviceAReady === true;
  const coverage = serviceAReady ? state.lastCoverage ?? null : null;

  const scheduler = buildSchedulerStatus(state, coverage ?? state.lastCoverage, now);

  const latestDir = path.join(process.cwd(), "out", "intel");
  const latest = {
    heat_latest: statInfo(path.join(latestDir, "heat_latest.json")),
    heat_triage_latest: statInfo(path.join(latestDir, "heat_triage_latest.json")),
    metrics_daily_latest: statInfo(path.join(latestDir, "metrics_daily_latest.json")),
    metrics_timeofday_latest: statInfo(path.join(latestDir, "metrics_timeofday_latest.json")),
    open_loops_state: statInfo(path.join(process.cwd(), "out", "chat_ea_state.jsonl")),
    digest_today: statInfo(path.join(process.cwd(), "out", "digest_today.json")),
  };

  res.json({
    serviceB: {
      ok: true,
      ts: now,
      version: (() => {
        try {
          const raw = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");
          return JSON.parse(raw)?.version ?? "unknown";
        } catch {
          return "unknown";
        }
      })(),
      uptimeMs: Math.round(process.uptime() * 1000),
    },
    scheduler: {
      enabled: scheduler.enabled,
      tickId: scheduler.tickId,
      lastTickAt: scheduler.lastTickAt,
      nextDue: scheduler.nextDue,
      lastErrors: scheduler.lastErrors,
    },
    serviceA: {
      reachable: state.serviceAReachable ?? null,
      ready: state.serviceAReady ?? null,
      state: state.serviceAState ?? null,
      needsQr: state.serviceANeedsQr ?? null,
      statusCheckedAt: state.serviceAStatusCheckedAt ?? null,
      readyAt: state.serviceAReadyAt ?? null,
      lastMessageAt: (state.lastCoverage as any)?.lastMessageTs ?? null,
    },
    coverage,
    latest,
  });
});
