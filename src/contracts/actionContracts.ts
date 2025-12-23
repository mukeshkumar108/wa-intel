// Canonical action contract skeleton (no behavior yet).
// TODO: Wire these contracts into orchestrator/metrics when ready.

export type Signal =
  | "event_priority_high"
  | "watermark_stale"
  | "coverage_thin"
  | "manual_backfill_request"
  | "metrics_recompute_needed";

export type Action = "POST_BACKFILL_TARGETS" | "ENQUEUE_METRICS_DAILY_CHAT" | "ENQUEUE_SIGNALS_EVENTS_CHAT" | "NO_OP";

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
  event_priority_high: "POST_BACKFILL_TARGETS",
  watermark_stale: "ENQUEUE_METRICS_DAILY_CHAT",
  coverage_thin: "NO_OP",
  manual_backfill_request: "POST_BACKFILL_TARGETS",
  metrics_recompute_needed: "ENQUEUE_METRICS_DAILY_CHAT",
};

export type SignalContext = {
  chatId: string;
  heatTier?: string | null;
  heatScore?: number | null;
  eventPriority?: boolean;
  coverageTargetMessages?: number | null;
  messageCountKnown?: number | null;
  cooldown?: { lastPostedAt: number | null; cooldownMs: number; remainingMs: number | null };
  filtersApplied?: string[];
  computedAt: number;
};

export type ReasonCode =
  | "cooldown_active"
  | "filtered_broadcast"
  | "filtered_lid"
  | "filtered_group"
  | "cap_maxChats"
  | "cap_rateLimit"
  | "missing_target"
  | "ok_posted"
  | "all_candidates_in_cooldown"
  | "no_planned_targets"
  | "serviceA_not_ready"
  | "capped_or_filtered_out"
  | "no_signal_candidates"
  | "serviceA_error";

export type ActionPlanV1 = {
  version: 1;
  runId: number | null;
  createdAtTs: number;
  inputsSummary: any;
  decisions: Array<{
    chatId: string;
    action: Action;
    signalContext: SignalContext;
    reason: ReasonCode;
  }>;
  actionsPlanned: any[];
  actionsExecuted: any[];
  results: any;
  evidence?: any;
};
