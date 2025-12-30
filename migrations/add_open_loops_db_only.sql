-- Extend open_loops for runtime state
ALTER TABLE open_loops
  ADD COLUMN IF NOT EXISTS snooze_until BIGINT,
  ADD COLUMN IF NOT EXISTS lane_override TEXT,
  ADD COLUMN IF NOT EXISTS override_note TEXT;

-- Cursors for open loops processing
CREATE TABLE IF NOT EXISTS open_loop_cursors (
  chat_id TEXT PRIMARY KEY,
  last_processed_ts BIGINT,
  last_processed_message_id TEXT,
  last_run_to_ts BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
