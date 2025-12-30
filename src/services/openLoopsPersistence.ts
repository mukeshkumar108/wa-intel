import { pool } from "../db.js";

const dualWriteEnabled = String(process.env.OPEN_LOOPS_DUAL_WRITE ?? "false").toLowerCase() === "true";
const dbOnly = String(process.env.OPEN_LOOPS_DB_ONLY ?? "false").toLowerCase() === "true";
const enableDb = true;

type ActiveLoop = {
  id?: string;
  loopKey?: string;
  chatId?: string;
  summary?: string;
  type?: string;
  status?: string;
  urgency?: string;
  importance?: number;
  confidence?: number;
  when?: string | null;
  whenDate?: string | null;
  hasTime?: boolean;
  lane?: string;
  firstSeenTs?: number;
  lastSeenTs?: number;
  [key: string]: any;
};

export async function saveActiveLoopsToDb(loops: ActiveLoop[], source = "ea_v2") {
  if (!enableDb) return;
  if (!Array.isArray(loops) || loops.length === 0) return;
  try {
    const values: string[] = [];
    const params: any[] = [];
    let idx = 1;

    for (const l of loops) {
      const loopId = l.id ?? l.loopKey ?? `${l.chatId ?? "unknown"}:${idx}`;
      const placeholders = Array.from({ length: 16 }, () => `$${idx++}`);
      values.push(`(${placeholders.join(",")})`);
      params.push(
        loopId,
        l.chatId ?? null,
        source,
        l.summary ?? null,
        l.type ?? null,
        l.status ?? null,
        l.urgency ?? null,
        Number.isFinite(l.importance) ? l.importance : null,
        Number.isFinite(l.confidence) ? l.confidence : null,
        l.when ?? null,
        l.whenDate ?? null,
        typeof l.hasTime === "boolean" ? l.hasTime : null,
        l.lane ?? null,
        Number.isFinite(l.firstSeenTs) ? l.firstSeenTs : null,
        Number.isFinite(l.lastSeenTs) ? l.lastSeenTs : null,
        l // payload jsonb
      );
    }

    const sql = `
      INSERT INTO open_loops (
        loop_id, chat_id, source, summary, type, status, urgency, importance, confidence,
        when_ts, when_date, has_time, lane, first_seen_ts, last_seen_ts, payload
      )
      VALUES ${values.join(",")}
      ON CONFLICT (loop_id, chat_id, source)
      DO UPDATE SET
        summary = EXCLUDED.summary,
        type = EXCLUDED.type,
        status = EXCLUDED.status,
        urgency = EXCLUDED.urgency,
        importance = EXCLUDED.importance,
        confidence = EXCLUDED.confidence,
        when_ts = EXCLUDED.when_ts,
        when_date = EXCLUDED.when_date,
        has_time = EXCLUDED.has_time,
        lane = EXCLUDED.lane,
        first_seen_ts = COALESCE(open_loops.first_seen_ts, EXCLUDED.first_seen_ts),
        last_seen_ts = GREATEST(open_loops.last_seen_ts, EXCLUDED.last_seen_ts),
        payload = EXCLUDED.payload,
        updated_at = now()
    `;

    await pool.query(sql, params);
  } catch (err) {
    console.error("[openLoopsDualWrite] saveActiveLoopsToDb failed", err);
    if (dbOnly) throw err;
  }
}

export async function saveDebugRunToDb(run: {
  chatId: string;
  ts: number;
  runType?: string;
  fromTs?: number;
  toTs?: number;
  messageCount?: number;
  rawOpenLoops?: any[];
  sanitizedOpenLoops?: any[];
  dropped?: any[];
}) {
  if (!enableDb) return;
  if (!run?.chatId || !Number.isFinite(run.ts)) return;
  try {
    await pool.query(
      `
      INSERT INTO open_loop_runs
        (chat_id, run_ts, run_type, from_ts, to_ts, message_count, raw_open_loops, sanitized_open_loops, dropped)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
      [
        run.chatId,
        run.ts,
        run.runType ?? null,
        Number.isFinite(run.fromTs) ? run.fromTs : null,
        Number.isFinite(run.toTs) ? run.toTs : null,
        Number.isFinite(run.messageCount) ? run.messageCount : null,
        run.rawOpenLoops ?? null,
        run.sanitizedOpenLoops ?? null,
        run.dropped ?? null,
      ]
    );
  } catch (err) {
    console.error("[openLoopsDualWrite] saveDebugRunToDb failed", err);
    if (dbOnly) throw err;
  }
}

export async function getOpenLoopCursor(chatId: string): Promise<{
  chatId: string;
  lastProcessedTs: number | null;
  lastProcessedMessageId?: string | null;
  lastRunToTs?: number | null;
} | null> {
  if (!enableDb) return null;
  try {
    const res = await pool.query(
      "SELECT chat_id, last_processed_ts, last_processed_message_id, last_run_to_ts FROM open_loop_cursors WHERE chat_id = $1",
      [chatId]
    );
    const row = res.rows?.[0];
    if (!row) return null;
    return {
      chatId: row.chat_id,
      lastProcessedTs: row.last_processed_ts ?? null,
      lastProcessedMessageId: row.last_processed_message_id ?? null,
      lastRunToTs: row.last_run_to_ts ?? null,
    };
  } catch (err) {
    console.error("[openLoops] getOpenLoopCursor failed", err);
    if (dbOnly) throw err;
    return null;
  }
}

export async function saveOpenLoopCursor(cursor: {
  chatId: string;
  lastProcessedTs: number | null;
  lastProcessedMessageId?: string | null;
  lastRunToTs?: number | null;
}) {
  if (!enableDb) return;
  if (!cursor?.chatId) return;
  try {
    await pool.query(
      `
      INSERT INTO open_loop_cursors (chat_id, last_processed_ts, last_processed_message_id, last_run_to_ts, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (chat_id) DO UPDATE
        SET last_processed_ts = EXCLUDED.last_processed_ts,
            last_processed_message_id = EXCLUDED.last_processed_message_id,
            last_run_to_ts = EXCLUDED.last_run_to_ts,
            updated_at = now()
      `,
      [cursor.chatId, cursor.lastProcessedTs, cursor.lastProcessedMessageId ?? null, cursor.lastRunToTs ?? null]
    );
  } catch (err) {
    console.error("[openLoops] saveOpenLoopCursor failed", err);
    if (dbOnly) throw err;
  }
}

export async function updateLoopStatus(chatId: string, loopId: string, updates: { status?: string; snoozeUntil?: number | null }) {
  if (!enableDb) return;
  try {
    await pool.query(
      `
      UPDATE open_loops
      SET status = COALESCE($3, status),
          snooze_until = $4,
          updated_at = now()
      WHERE loop_id = $1 AND chat_id = $2
      `,
      [loopId, chatId, updates.status ?? null, updates.snoozeUntil ?? null]
    );
  } catch (err) {
    console.error("[openLoops] updateLoopStatus failed", err);
    if (dbOnly) throw err;
  }
}
