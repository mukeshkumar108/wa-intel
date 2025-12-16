import { Router } from "express";
import { fetchRecentMessages } from "../whatsappClient.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

healthRouter.get("/health/deps", async (_req, res) => {
  const start = Date.now();
  let ok = false;
  let error: string | undefined;
  try {
    await fetchRecentMessages(1);
    ok = true;
  } catch (err: any) {
    ok = false;
    error = err?.message ?? String(err);
  }
  res.json({
    status: "ok",
    deps: {
      serviceA: {
        ok,
        latencyMs: Date.now() - start,
        error,
      },
    },
  });
});
