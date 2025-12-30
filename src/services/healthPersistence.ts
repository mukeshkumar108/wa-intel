import { pool } from "../db.js";

const dualWriteEnabled = String(process.env.OPEN_LOOPS_DUAL_WRITE ?? "false").toLowerCase() === "true";

type HeartbeatState = {
  service_a_status?: any;
  orchestrator_state?: any;
  last_run_ts?: number;
  last_error?: any;
};

export async function saveSystemHeartbeat(state: HeartbeatState) {
  if (!dualWriteEnabled) return;
  try {
    const serviceAStatus = state?.service_a_status ?? null;
    const orchestratorState = state?.orchestrator_state ?? null;
    const lastRunTs = Number.isFinite(state?.last_run_ts) ? state?.last_run_ts : Date.now();
    const lastError = state?.last_error ?? null;

    await pool.query(
      `
      INSERT INTO system_status (id, service_a_status, orchestrator_state, last_run_ts, last_error, updated_at)
      VALUES (1, $1, $2, $3, $4, now())
      ON CONFLICT (id) DO UPDATE
        SET service_a_status = EXCLUDED.service_a_status,
            orchestrator_state = EXCLUDED.orchestrator_state,
            last_run_ts = EXCLUDED.last_run_ts,
            last_error = EXCLUDED.last_error,
            updated_at = now()
      `,
      [serviceAStatus, orchestratorState, lastRunTs, lastError]
    );
  } catch (err) {
    console.error("[healthPersistence] saveSystemHeartbeat failed", err);
  }
}
