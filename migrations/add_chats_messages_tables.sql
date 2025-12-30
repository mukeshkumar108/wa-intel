CREATE TABLE IF NOT EXISTS chats (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  message_count  INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender    TEXT,
  content   TEXT,
  ts        BIGINT,
  role      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, ts);
