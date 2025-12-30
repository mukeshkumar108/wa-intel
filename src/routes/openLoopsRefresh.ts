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
    const includeGroups = String(req.query.includeGroups ?? "true").toLowerCase() === "true";
    const results = await refreshEAOpenLoopsForRecentChats(hours, { force, runType, maxNewMessages, includeGroups });
    const artifactPayload = {
      runId,
      windowHours: hours,
      chatsProcessed: results.length,
      loopsAdded: 0,
      loopsClosed: 0,
      evidencePointers: { sample: (results ?? []).slice(0, 5) },
    };
    const artifactId = await saveArtifact({ runId, artifactType: "open_loops_refresh_result", payload: artifactPayload });
    await finishRun(runId, { status: "ok" });
    res.json({ ok: true, runId, artifactId, summary: { chatsProcessed: results.length, windowHours: hours } });
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("Error in /open-loops/refresh:", err?.message ?? err);
    res.status(500).json({ error: "Failed to refresh open loops" });
  }
});
