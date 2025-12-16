import { Router } from "express";
import { refreshEAOpenLoopsForRecentChats } from "../services/eaOpenLoopsService.js";
import { generateDailyDigest } from "../services/digestService.js";

export const onboardingPrimeRouter = Router();

// POST /onboarding/prime?hours=6
// Protected by API key middleware in index.ts (same as other routes)
onboardingPrimeRouter.post("/onboarding/prime", async (req, res) => {
  try {
    const hours = Number(req.query.hours ?? 6);
    const h = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24) : 6;
    await refreshEAOpenLoopsForRecentChats(h, { force: true, runType: "manual" });
    const today = new Date().toISOString().slice(0, 10);
    await generateDailyDigest(today, { force: true });
    res.json({ ok: true, hours: h });
  } catch (err: any) {
    console.error("Error in /onboarding/prime:", err?.message ?? err);
    res.status(500).json({ error: "Failed to prime account" });
  }
});
