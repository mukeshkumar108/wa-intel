import { Router } from "express";
import { z } from "zod";
import { ActiveOpenLoop, getCuratedPlateOpenLoops } from "../services/openLoopsV2Service.js";
import { updateLoopStatus } from "../services/openLoopsPersistence.js";
import { pool } from "../db.js";

export const openLoopsRouter = Router();

const daysSchema = z
  .string()
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n) && n > 0 && n <= 60, {
    message: "days must be between 1 and 60",
  });

async function resolveLoop(id: string): Promise<{ chatId: string; loopId: string } | null> {
  const res = await pool.query("SELECT chat_id, loop_id FROM open_loops WHERE loop_id = $1 LIMIT 1", [id]);
  const row = res.rows?.[0];
  if (!row) return null;
  return { chatId: row.chat_id, loopId: row.loop_id };
}

// GET /open-loops?limit=<n>
// 1) Fetch recent messages
// 2) Ask LLM for extracted open loops
// 3) Attach "who" from metadata
// 4) Upsert into JSON store
// 5) Return active stored open loops
openLoopsRouter.get("/open-loops", async (req, res) => {
  try {
    const daysStr = (req.query.days as string | undefined) ?? "7";
    const days = daysSchema.parse(daysStr);
    const plate = await getCuratedPlateOpenLoops(days);

    res.json({
      openLoops: plate.openLoops as ActiveOpenLoop[],
      meta: { days },
    });
  } catch (err: any) {
    console.error("Error in /open-loops:", err?.message ?? err);
    res.status(500).json({ error: "Failed to load open loops" });
  }
});

// GET /open-loops/active
// Return curated active loops without re-calling the LLM.
openLoopsRouter.get("/open-loops/active", async (req, res) => {
  try {
    const lane = (req.query.lane as string | undefined) ?? "now";
    const plate = await getCuratedPlateOpenLoops(7);
    const filtered =
      lane === "later"
        ? plate.openLoops.filter((l) => l.lane === "later")
        : plate.openLoops.filter((l) => l.lane !== "later");
    res.json({ openLoops: filtered });
  } catch (err: any) {
    console.error("Error in /open-loops/active:", err?.message ?? err);
    res.status(500).json({ error: "Failed to load active open loops" });
  }
});

// POST /open-loops/:id/complete
openLoopsRouter.post("/open-loops/:id/complete", async (req, res) => {
  try {
    const { id } = req.params;
    const resolved = await resolveLoop(id);
    if (!resolved) return res.status(404).json({ error: "Open loop not found" });
    await updateLoopStatus(resolved.chatId, resolved.loopId, { status: "done" });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("Error in /open-loops/:id/complete:", err?.message ?? err);
    res.status(500).json({ error: "Failed to update open loop" });
  }
});

// POST /open-loops/:id/dismiss
openLoopsRouter.post("/open-loops/:id/dismiss", async (req, res) => {
  try {
    const { id } = req.params;
    const resolved = await resolveLoop(id);
    if (!resolved) return res.status(404).json({ error: "Open loop not found" });
    await updateLoopStatus(resolved.chatId, resolved.loopId, { status: "dismissed" });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("Error in /open-loops/:id/dismiss:", err?.message ?? err);
    res.status(500).json({ error: "Failed to update open loop" });
  }
});

const snoozeSchema = z.object({
  hours: z.number().positive().max(24 * 30),
});

openLoopsRouter.post("/open-loops/:id/snooze", async (req, res) => {
  try {
    const { id } = req.params;
    const parsed = snoozeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const resolved = await resolveLoop(id);
    if (!resolved) return res.status(404).json({ error: "Open loop not found" });
    const snoozeUntil = Date.now() + parsed.data.hours * 60 * 60 * 1000;
    await updateLoopStatus(resolved.chatId, resolved.loopId, { snoozeUntil, status: undefined });
    res.json({ ok: true, snoozeUntil });
  } catch (err: any) {
    console.error("Error in /open-loops/:id/snooze:", err?.message ?? err);
    res.status(500).json({ error: "Failed to update open loop" });
  }
});
