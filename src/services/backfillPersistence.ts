import { pool } from "../db.js";

const dualWriteEnabled = String(process.env.OPEN_LOOPS_DUAL_WRITE ?? "false").toLowerCase() === "true";

export async function queueBackfillTargets(chatIds: string[]): Promise<void> {
  if (!dualWriteEnabled) return;
  if (!Array.isArray(chatIds) || chatIds.length === 0) return;
  const unique = Array.from(new Set(chatIds.filter((c) => typeof c === "string" && c.trim().length > 0)));
  if (!unique.length) return;
  try {
    const values: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const chatId of unique) {
      values.push(`($${idx++})`);
      params.push(chatId);
    }
    const sql = `
      INSERT INTO backfill_queue (chat_id)
      VALUES ${values.join(",")}
      ON CONFLICT (chat_id)
      DO UPDATE SET updated_at = now()
    `;
    await pool.query(sql, params);
  } catch (err) {
    console.error("[backfillPersistence] queueBackfillTargets failed", err);
  }
}

export async function updateBackfillStatus(chatId: string, status: "pending" | "processing" | "completed" | "failed") {
  if (!dualWriteEnabled) return;
  if (!chatId) return;
  try {
    await pool.query(
      `
      INSERT INTO backfill_queue (chat_id, status)
      VALUES ($1, $2)
      ON CONFLICT (chat_id)
      DO UPDATE SET status = EXCLUDED.status, updated_at = now()
      `,
      [chatId, status]
    );
  } catch (err) {
    console.error("[backfillPersistence] updateBackfillStatus failed", err);
  }
}
