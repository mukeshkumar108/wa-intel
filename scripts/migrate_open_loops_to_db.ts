import fs from "fs";
import path from "path";
import { pool } from "../src/db.js";

type FileOverride = { key: string; status?: string; snoozeUntil?: number };

async function loadJsonlStates() {
  const p = path.join(process.cwd(), "out", "chat_ea_state.jsonl");
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length);
  return lines.map((l) => JSON.parse(l));
}

function loadOverrides(): FileOverride[] {
  const p = path.join(process.cwd(), "out", "openLoopOverrides.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function loadCursors() {
  const p = path.join(process.cwd(), "out", "chat_cursors.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

async function migrate() {
  const states = await loadJsonlStates();
  const overrides = loadOverrides();
  const cursorMap = loadCursors();
  const overrideByKey = new Map(overrides.map((o) => [o.key, o]));

  for (const state of states) {
    const loops = state?.openLoops ?? [];
    for (const l of loops) {
      const key = l.loopKey ? `${l.chatId}|${l.loopKey}` : l.id;
      const ov = overrideByKey.get(key);
      const snoozeUntil = ov?.snoozeUntil ?? null;
      const status = ov?.status ?? l.status ?? "open";
      await pool.query(
        `
        INSERT INTO open_loops (loop_id, chat_id, source, summary, type, status, urgency, importance, confidence, when_ts, when_date, has_time, lane, first_seen_ts, last_seen_ts, payload, snooze_until)
        VALUES ($1,$2,'ea_v2',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (loop_id, chat_id, source) DO UPDATE
          SET summary=EXCLUDED.summary,
              type=EXCLUDED.type,
              status=EXCLUDED.status,
              urgency=EXCLUDED.urgency,
              importance=EXCLUDED.importance,
              confidence=EXCLUDED.confidence,
              when_ts=EXCLUDED.when_ts,
              when_date=EXCLUDED.when_date,
              has_time=EXCLUDED.has_time,
              lane=EXCLUDED.lane,
              first_seen_ts=COALESCE(open_loops.first_seen_ts, EXCLUDED.first_seen_ts),
              last_seen_ts=GREATEST(open_loops.last_seen_ts, EXCLUDED.last_seen_ts),
              payload=EXCLUDED.payload,
              snooze_until=EXCLUDED.snooze_until,
              updated_at=now()
        `,
        [
          l.id,
          l.chatId,
          l.summary,
          l.type,
          status,
          l.urgency,
          l.importance,
          l.confidence,
          l.when ?? null,
          l.whenDate ?? null,
          l.hasTime ?? false,
          l.lane ?? null,
          l.firstSeenTs ?? null,
          l.lastSeenTs ?? null,
          l,
          snoozeUntil,
        ]
      );
    }
  }

  for (const [chatId, cur] of Object.entries<any>(cursorMap)) {
    await pool.query(
      `
      INSERT INTO open_loop_cursors (chat_id, last_processed_ts, last_processed_message_id, last_run_to_ts, updated_at)
      VALUES ($1,$2,$3,$4, now())
      ON CONFLICT (chat_id) DO UPDATE
        SET last_processed_ts=EXCLUDED.last_processed_ts,
            last_processed_message_id=EXCLUDED.last_processed_message_id,
            last_run_to_ts=EXCLUDED.last_run_to_ts,
            updated_at=now()
      `,
      [chatId, cur.lastProcessedTs ?? null, cur.lastProcessedMessageId ?? null, cur.lastRunToTs ?? null]
    );
  }

  console.log("Migration complete");
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
