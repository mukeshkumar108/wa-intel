import { pool } from "../db.js";

type ChatStatePatch = {
  oldest_ts_seen_ms?: number | null;
  newest_ts_seen_ms?: number | null;
  seen_msg_count?: number | null;
  last_run_at?: number | null;
  last_run_type?: string | null;
};

export async function getChatState(chatId: string): Promise<any | null> {
  try {
    const res = await pool.query(
      "SELECT chat_id, oldest_ts_seen_ms, newest_ts_seen_ms, seen_msg_count, last_run_at, last_run_type FROM chat_pipeline_state WHERE chat_id = $1 LIMIT 1",
      [chatId]
    );
    return res.rows?.[0] ?? null;
  } catch (err) {
    console.error("[chatPipelineState] getChatState failed", err);
    return null;
  }
}

export async function upsertChatState(chatId: string, patch: ChatStatePatch): Promise<void> {
  try {
    const fields: string[] = ["chat_id"];
    const values: any[] = [chatId];
    const updates: string[] = [];

    if (patch.oldest_ts_seen_ms !== undefined) {
      fields.push("oldest_ts_seen_ms");
      values.push(patch.oldest_ts_seen_ms);
      updates.push("oldest_ts_seen_ms = EXCLUDED.oldest_ts_seen_ms");
    }
    if (patch.newest_ts_seen_ms !== undefined) {
      fields.push("newest_ts_seen_ms");
      values.push(patch.newest_ts_seen_ms);
      updates.push("newest_ts_seen_ms = EXCLUDED.newest_ts_seen_ms");
    }
    if (patch.seen_msg_count !== undefined) {
      fields.push("seen_msg_count");
      values.push(patch.seen_msg_count);
      updates.push("seen_msg_count = EXCLUDED.seen_msg_count");
    }
    if (patch.last_run_at !== undefined) {
      fields.push("last_run_at");
      values.push(patch.last_run_at);
      updates.push("last_run_at = EXCLUDED.last_run_at");
    }
    if (patch.last_run_type !== undefined) {
      fields.push("last_run_type");
      values.push(patch.last_run_type);
      updates.push("last_run_type = EXCLUDED.last_run_type");
    }

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");
    const updateSql = updates.length ? `ON CONFLICT (chat_id) DO UPDATE SET ${updates.join(", ")}` : "ON CONFLICT DO NOTHING";
    const sql = `INSERT INTO chat_pipeline_state (${fields.join(", ")}) VALUES (${placeholders}) ${updateSql}`;

    await pool.query(sql, values);
  } catch (err) {
    console.error("[chatPipelineState] upsertChatState failed", err);
  }
}
