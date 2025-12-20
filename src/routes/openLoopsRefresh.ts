import { Router } from "express";
import { refreshEAOpenLoopsForRecentChats } from "../services/eaOpenLoopsService.js";
import { startRun, finishRun, saveArtifact } from "../services/intelPersistence.js";

export const openLoopsRefreshRouter = Router();

openLoopsRefreshRouter.post("/open-loops/refresh", async (req, res) => {
  const runId = await startRun({
    kind: "open_loops_refresh_run",
    runType: (req.query.runType as string | undefined) ?? "manual",
    params: req.query,
  });
  try {
    const hoursParam = Number(req.query.hours ?? 48);
    const hours = Number.isFinite(hoursParam) && hoursParam > 0 ? Math.min(hoursParam, 240) : 48;
    const force = String(req.query.force ?? "false").toLowerCase() === "true";
    const runType = (req.query.runType as string | undefined) as any;
    const limitParam = Number(req.query.limit ?? 5000);
    const maxNewMessages = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 5000;
    const results = await refreshEAOpenLoopsForRecentChats(hours, { force, runType, maxNewMessages });
    await saveArtifact({ runId, artifactType: "open_loops_refresh_result", payload: { chatsProcessed: results.length } });
    await finishRun(runId, { status: "ok" });
    res.json({ chatsProcessed: results.length });
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /open-loops/refresh:", err?.message ?? err);
    res.status(500).json({ error: "Failed to refresh open loops" });
  }
});
