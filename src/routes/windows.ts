import { Router } from "express";
import { backfillWindowsForLastHours, loadRecentWindowSummary } from "../services/windowAnalysisService.js";

export const windowsRouter = Router();

windowsRouter.post("/v2/windows/backfill", async (req, res) => {
  try {
    const hoursParam = Number(req.query.hours ?? 24);
    const hours = Number.isFinite(hoursParam) && hoursParam > 0 ? Math.min(hoursParam, 240) : 24;
    const force = String(req.query.force ?? "false").toLowerCase() === "true";

    const analyses = await backfillWindowsForLastHours(hours, force);
    res.json({
      windowsProcessed: analyses.length,
      windowIds: analyses.map((a) => a.id).filter((id) => typeof id === "string" && id.length > 0),
    });
  } catch (err: any) {
    console.error("Error in /v2/windows/backfill:", err);
    res.status(500).json({ error: "Failed to backfill window analyses" });
  }
});

windowsRouter.get("/v2/windows/recent", async (req, res) => {
  try {
    const daysParam = Number(req.query.days ?? 7);
    const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 60) : 7;
    const result = await loadRecentWindowSummary(days);
    res.json(result);
  } catch (err: any) {
    console.error("Error in /v2/windows/recent:", err?.message ?? err);
    res.status(500).json({ error: "Failed to load recent window analyses" });
  }
});
