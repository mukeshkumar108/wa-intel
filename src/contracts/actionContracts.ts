// Canonical action contract skeleton (no behavior yet).
// TODO: Wire these contracts into orchestrator/metrics when ready.

export type Signal =
  | "event_priority_high"
  | "watermark_stale"
  | "coverage_thin"
  | "manual_backfill_request"
  | "metrics_recompute_needed";

export type Action = "backfill_target_set" | "enqueue_metrics_chat" | "enqueue_signals_chat" | "noop";

export type ActionEvidence = {
  source: string;
  chatId?: string;
  ts: number;
  details?: any;
};

export type ActionDecision = {
  signal: Signal;
  action: Action;
  chatId?: string;
  rationale?: string;
  evidence?: ActionEvidence[];
};

// Skeleton mapping; extend when implementing.
export const actionContracts: Record<Signal, Action> = {
  event_priority_high: "backfill_target_set",
  watermark_stale: "enqueue_metrics_chat",
  coverage_thin: "noop",
  manual_backfill_request: "backfill_target_set",
  metrics_recompute_needed: "enqueue_metrics_chat",
};
