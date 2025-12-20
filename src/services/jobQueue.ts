import { pool } from "../db.js";

type JobPayload = any;

export async function enqueueJob(kind: string, payload: JobPayload, dedupeKey?: string | null, notBeforeTs?: number | null) {
  try {
    const payloadCopy: any = payload ?? {};
    if (dedupeKey) payloadCopy.dedupeKey = dedupeKey;
    const chatId = payloadCopy?.chatId ?? null;

    if (dedupeKey) {
      const existing = await pool.query(
        "SELECT id FROM jobs WHERE status IN ('queued','running') AND type = $1 AND chat_id = $2 AND payload->>'dedupeKey' = $3 LIMIT 1",
        [kind, chatId, dedupeKey]
      );
      if (existing.rows?.length) return existing.rows[0]?.id ?? null;
    }

    await pool.query(
      `
      INSERT INTO jobs (type, chat_id, payload, status, run_after)
      VALUES ($1, $2, $3, 'queued', COALESCE(to_timestamp($4 / 1000.0), now()))
    `,
      [kind, chatId, payloadCopy, notBeforeTs ?? null]
    );
  } catch (err) {
    console.error("[jobQueue] enqueueJob failed", err);
  }
}

export async function claimJobs(limit: number) {
  try {
    const res = await pool.query(
      `
      UPDATE jobs
      SET status = 'running', locked_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id
        FROM jobs
        WHERE status = 'queued' AND (run_after IS NULL OR run_after <= now()) AND locked_at IS NULL
        ORDER BY run_after ASC NULLS FIRST, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      RETURNING *
    `,
      [limit]
    );
    return res.rows ?? [];
  } catch (err) {
    console.error("[jobQueue] claimJobs failed", err);
    return [];
  }
}

export async function completeJob(id: number) {
  try {
    await pool.query(`UPDATE jobs SET status = 'done', locked_at = NULL, updated_at = now() WHERE id = $1`, [id]);
  } catch (err) {
    console.error("[jobQueue] completeJob failed", err);
  }
}

export async function failJob(id: number, error?: string) {
  try {
    await pool.query(
      `
      UPDATE jobs
      SET status = 'queued',
          locked_at = NULL,
          attempts = COALESCE(attempts, 0) + 1,
          last_error = $2,
          run_after = now() + (
            CASE
              WHEN COALESCE(attempts,0) = 0 THEN INTERVAL '5 minutes'
              WHEN COALESCE(attempts,0) = 1 THEN INTERVAL '30 minutes'
              ELSE INTERVAL '2 hours'
            END
          ),
          updated_at = now()
      WHERE id = $1
    `,
      [id, error ? String(error).slice(0, 500) : null]
    );
  } catch (err) {
    console.error("[jobQueue] failJob failed", err);
  }
}
