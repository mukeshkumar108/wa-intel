import { pool } from "../db.js";

type StartRunArgs = { kind: string; runType?: string; params?: any };
type FinishRunArgs = { status: string; error?: string };
type ArtifactArgs = { runId: number | null; artifactType: string; chatId?: string | null; payload: any };
type EventRecord = {
  ts: number;
  chatId: string;
  type: string;
  direction: string;
  confidence?: number | null;
};

export async function startRun({ kind, runType, params }: StartRunArgs): Promise<number | null> {
  try {
    const res = await pool.query(
      `INSERT INTO intel_runs (kind, run_type, params, status) VALUES ($1, $2, $3, 'running') RETURNING id`,
      [kind, runType ?? null, params ?? null]
    );
    return Number(res?.rows?.[0]?.id ?? null);
  } catch (err) {
    console.error("[intelPersistence] startRun failed", err);
    return null;
  }
}

export async function finishRun(runId: number | null, { status, error }: FinishRunArgs): Promise<void> {
  if (runId == null) return;
  try {
    await pool.query(
      `UPDATE intel_runs SET status = $1, error = $2, finished_at = now() WHERE id = $3`,
      [status, error ?? null, runId]
    );
  } catch (err) {
    console.error("[intelPersistence] finishRun failed", err);
  }
}

export async function saveArtifact({ runId, artifactType, chatId, payload }: ArtifactArgs): Promise<void> {
  if (runId == null) return;
  try {
    await pool.query(
      `INSERT INTO intel_artifacts (run_id, artifact_type, chat_id, payload) VALUES ($1, $2, $3, $4)`,
      [runId, artifactType, chatId ?? null, payload ?? null]
    );
  } catch (err) {
    console.error("[intelPersistence] saveArtifact failed", err);
  }
}

export async function saveEvents(runId: number | null, events: EventRecord[]): Promise<void> {
  if (runId == null) return;
  if (!Array.isArray(events) || events.length === 0) return;
  try {
    const values = [];
    const params: any[] = [];
    let idx = 1;
    for (const e of events) {
      if (!e || typeof e.chatId !== "string" || typeof e.ts !== "number" || typeof e.type !== "string" || typeof e.direction !== "string") {
        continue;
      }
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(runId, e.ts, e.chatId, e.type, e.direction, Number.isFinite(e.confidence) ? e.confidence : null);
    }
    if (!values.length) return;
    const sql = `
      INSERT INTO intel_events (run_id, ts, chat_id, type, direction, confidence)
      VALUES ${values.join(",")}
    `;
    await pool.query(sql, params);
  } catch (err) {
    console.error("[intelPersistence] saveEvents failed", err);
  }
}

export async function getLastEventTsByChat(type: string, chatIds: string[]): Promise<Record<string, number>> {
  if (!chatIds.length) return {};
  try {
    const res = await pool.query(
      "SELECT chat_id, MAX(ts) as ts FROM intel_events WHERE type = $1 AND chat_id = ANY($2) GROUP BY chat_id",
      [type, chatIds]
    );
    const map: Record<string, number> = {};
    for (const row of res.rows ?? []) {
      const ts = Number(row?.ts ?? 0);
      if (Number.isFinite(ts)) map[row.chat_id ?? row.chatId] = ts;
    }
    return map;
  } catch (err) {
    console.warn("[intelPersistence] getLastEventTsByChat failed", err);
    return {};
  }
}

export async function saveBackfillPosts(events: { chatId: string; ts: number }[], runId?: number | null): Promise<void> {
  if (!Array.isArray(events) || events.length === 0) return;
  try {
    const values: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const e of events) {
      if (!e?.chatId || !Number.isFinite(e.ts)) continue;
      values.push(`($${idx++}, $${idx++}, $${idx++}, 'backfill_target_posted', $${idx++}, $${idx++})`);
      params.push(runId ?? null, e.ts, e.chatId, "system", 1);
    }
    if (!values.length) return;
    const sql = `
      INSERT INTO intel_events (run_id, ts, chat_id, type, direction, confidence)
      VALUES ${values.join(",")}
    `;
    await pool.query(sql, params);
  } catch (err) {
    console.error("[intelPersistence] saveBackfillPosts failed", err);
  }
}

export async function getLastBackfillPostedByChatIds(chatIds: string[]): Promise<Record<string, number>> {
  if (!chatIds.length) return {};
  try {
    const res = await pool.query(
      `
        SELECT chat_id, MAX(ts) AS last_ts
        FROM intel_events
        WHERE type = 'backfill_target_posted' AND chat_id = ANY($1)
        GROUP BY chat_id
      `,
      [chatIds]
    );
    const map: Record<string, number> = {};
    for (const row of res.rows ?? []) {
      const ts = Number(row?.last_ts ?? row?.ts ?? 0);
      if (Number.isFinite(ts)) map[row.chat_id ?? row.chatId] = ts;
    }
    return map;
  } catch (err) {
    console.error("[intelPersistence] getLastBackfillPostedByChatIds failed", err);
    return {};
  }
}

export async function getRecentHighSignalChatIds(opts: { hours: number; types: string[]; limit: number }): Promise<string[]> {
  const { hours, types, limit } = opts;
  if (!types.length) return [];
  try {
    const since = Date.now() - hours * 60 * 60 * 1000;
    const params = [since, ...types, limit];
    const placeholders = types.map((_, i) => `$${i + 2}`).join(",");
    const sql = `
      SELECT chat_id, MAX(ts) as latest_ts, COUNT(*) as cnt
      FROM intel_events
      WHERE ts >= $1 AND type IN (${placeholders})
      GROUP BY chat_id
      ORDER BY latest_ts DESC, cnt DESC
      LIMIT $${types.length + 2}
    `;
    const res = await pool.query(sql, params);
    return (res.rows ?? []).map((r) => r.chat_id ?? r.chatId).filter((c: any) => typeof c === "string");
  } catch (err) {
    console.error("[intelPersistence] getRecentHighSignalChatIds failed", err);
    return [];
  }
}

export async function getBackfillPostedEvidence(hours: number = 24): Promise<{ count: number; newestTs: number | null } | null> {
  const windowHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  try {
    const res = await pool.query(
      "SELECT COUNT(*) AS count, MAX(ts) AS newest_ts FROM intel_events WHERE type = 'backfill_target_posted' AND ts >= $1",
      [since]
    );
    const row = res.rows?.[0];
    return {
      count: Number(row?.count ?? 0),
      newestTs: row?.newest_ts ? Number(row.newest_ts) : null,
    };
  } catch (err) {
    console.error("[intelPersistence] getBackfillPostedEvidence failed", err);
    return null;
  }
}
