CREATE TABLE IF NOT EXISTS backfill_queue (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  priority    INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backfill_queue_status ON backfill_queue (status);
CREATE INDEX IF NOT EXISTS idx_backfill_queue_priority ON backfill_queue (priority);
