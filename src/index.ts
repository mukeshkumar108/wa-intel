import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { healthRouter } from "./routes/health.js";
import { summaryRouter } from "./routes/summary.js";
import { openLoopsRouter } from "./routes/openLoops.js";
import { debugEaRouter } from "./routes/debugEa.js";
import { digestRouter } from "./routes/digest.js";
import { relationshipsRouter } from "./routes/relationships.js";
import { peopleRouter } from "./routes/people.js";
import stateRouter from "./routes/state.js";
import { adminRouter } from "./routes/admin.js";
import { windowsRouter } from "./routes/windows.js";
import { meRouter } from "./routes/me.js";
import { openLoopsRefreshRouter } from "./routes/openLoopsRefresh.js";
import { onboardingPrimeRouter } from "./routes/onboardingPrime.js";
import { intelRouter } from "./routes/intel.js";
import { uiRouter } from "./routes/ui.js";
import { Request, Response, NextFunction } from "express";
import { startOrchestratorScheduler } from "./services/orchestratorScheduler.js";

const app = express();

app.use(cors());
app.use(express.json());

const API_KEY = process.env.B_API_KEY;
function apiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  const path = req.path.toLowerCase();
  if (path.startsWith("/health")) return next();
  if (!API_KEY) return next();
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const token = header.replace("Bearer ", "").trim();
  if (token !== API_KEY) return res.status(403).json({ error: "Forbidden" });
  return next();
}
app.use(apiKeyMiddleware);

app.use(healthRouter);
app.use(summaryRouter);
app.use(openLoopsRouter);
app.use(debugEaRouter);
app.use(openLoopsRefreshRouter);
app.use(onboardingPrimeRouter);
app.use(digestRouter);
app.use(relationshipsRouter);
app.use(peopleRouter);
app.use("/state", stateRouter);
app.use(windowsRouter);
app.use("/me", meRouter);
app.use("/admin", adminRouter);
app.use(intelRouter);
app.use(uiRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  console.log(`Intel service listening on http://localhost:${config.port}`);
});

startOrchestratorScheduler();
