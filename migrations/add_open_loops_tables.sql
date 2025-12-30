-- Open Loops active state (dual-write target)
CREATE TABLE IF NOT EXISTS open_loops (
  id               BIGSERIAL PRIMARY KEY,
  loop_id          TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'ea_v2',
  summary          TEXT,
  type             TEXT,
  status           TEXT,
  urgency          TEXT,
  importance       INTEGER,
  confidence       DOUBLE PRECISION,
  when_ts          TIMESTAMPTZ NULL,
  when_date        DATE NULL,
  has_time         BOOLEAN,
  lane             TEXT,
  first_seen_ts    BIGINT,
  last_seen_ts     BIGINT,
  payload          JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (loop_id, chat_id, source)
);

CREATE INDEX IF NOT EXISTS idx_open_loops_chat_ts ON open_loops (chat_id, last_seen_ts DESC);

-- Open Loops debug runs (raw + sanitized LLM output)
CREATE TABLE IF NOT EXISTS open_loop_runs (
  id                  BIGSERIAL PRIMARY KEY,
  chat_id             TEXT NOT NULL,
  run_ts              BIGINT NOT NULL,
  run_type            TEXT,
  from_ts             BIGINT,
  to_ts               BIGINT,
  message_count       INTEGER,
  raw_open_loops      JSONB,
  sanitized_open_loops JSONB,
  dropped             JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_open_loop_runs_chat_ts ON open_loop_runs (chat_id, run_ts DESC);
