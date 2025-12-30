CREATE TABLE IF NOT EXISTS system_status (
  id                 INTEGER PRIMARY KEY,
  service_a_status   JSONB,
  orchestrator_state JSONB,
  last_run_ts        BIGINT,
  last_error         JSONB,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
