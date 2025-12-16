import { Router } from "express";
import { readLatestRun, summarizeRuns } from "../stores/eaDebugRunsStore.js";

export const debugEaRouter = Router();

debugEaRouter.get("/debug/ea/latest", async (req, res) => {
  try {
    const chatId = (req.query.chatId as string | undefined) ?? "";
    if (!chatId) return res.status(400).json({ error: "chatId required" });
    const latest = await readLatestRun(chatId);
    if (!latest) return res.status(404).json({ error: "No runs for chatId" });
    res.json(latest);
  } catch (err: any) {
    console.error("Error in /debug/ea/latest:", err?.message ?? err);
    res.status(500).json({ error: "Failed to load latest run" });
  }
});

debugEaRouter.get("/debug/ea/summary", async (req, res) => {
  try {
    const hours = Number((req.query.hours as string | undefined) ?? "24");
    if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
      return res.status(400).json({ error: "hours must be 0<h<=720" });
    }
    const summary = await summarizeRuns(hours);
    res.json(summary);
  } catch (err: any) {
    console.error("Error in /debug/ea/summary:", err?.message ?? err);
    res.status(500).json({ error: "Failed to load summary" });
  }
});
