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

export const intelRouter = Router();

intelRouter.post("/intel/bootstrap", async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours ?? 72) || 72, 240);
    const limitChats = Math.min(Number(req.query.limitChats ?? 50) || 50, 500);
    const limitPerChat = Math.min(Number(req.query.limitPerChat ?? 200) || 200, 2000);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const runType = (req.query.runType as string | undefined) ?? "manual";
    const result = await bootstrapIntel({ hours, limitChats, limitPerChat, includeGroups, runType });
    res.json(result);
  } catch (err: any) {
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
  try {
    const limitChats = Math.min(Number(req.query.limitChats ?? 50) || 50, 500);
    const limitPerChat = Math.min(Number(req.query.limitPerChat ?? 30) || 30, 2000);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const runType = (req.query.runType as string | undefined) ?? "manual";
    const execute = String(req.query.execute ?? "false").toLowerCase() === "true";
    const result = await runRadar({ limitChats, limitPerChat, includeGroups, runType, execute });
    res.json(result);
  } catch (err: any) {
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
  try {
    const force = String(req.query.force ?? "0") === "1";
    const runType = (req.query.runType as string | undefined) ?? "manual";
    const limitChats = Math.min(Number(req.query.limitChats ?? 50) || 50, 500);
    const limitPerChat = Math.min(Number(req.query.limitPerChat ?? 30) || 30, 2000);
    const result = await orchestrateRun({ force, runType, limitChats, limitPerChat });
    res.json(result);
  } catch (err: any) {
    console.error("Error in /intel/orchestrate/run:", err);
    res.status(500).json({ error: "Failed to run orchestrator" });
  }
});

intelRouter.post("/intel/metrics/time-of-day/run", async (req, res) => {
  try {
    const limitChats = Math.min(Number(req.query.limitChats ?? 50) || 50, 500);
    const limitPerChat = Math.min(Number(req.query.limitPerChat ?? 200) || 200, 2000);
    const includeGroups = String(req.query.includeGroups ?? "false").toLowerCase() === "true";
    const result = await runTimeOfDayMetrics({ limitChats, limitPerChat, includeGroups });
    res.json(result);
  } catch (err: any) {
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
    const result = await runDailyMetrics({ limitChats, limitPerChat, includeGroups, windows: windows.length ? windows : [1], tz });
    res.json(result);
  } catch (err: any) {
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
