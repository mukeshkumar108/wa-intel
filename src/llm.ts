import { callOpenRouter, ChatCompletionRequest } from "./openRouterClient.js";

export const MODEL_REGISTRY = {
  // 4-hour window analysis (V2 windows)
  // Use a more capable extractor for open loops
  window: "openai/gpt-4o-mini",

  // extraction / classification
  openLoops: "openai/gpt-4o-mini",
  digest: "openai/gpt-4o-mini",
  state: "openai/gpt-4o-mini",
  summary: "openai/gpt-4o-mini",

  // deeper relationship reasoning
  relationship: "openai/gpt-5-nano",
  relationshipRollup: "openai/gpt-5-nano",

  // coaching / reflection
  coaching: "openai/gpt-5-nano",
  userProfile: "openai/gpt-5-nano",

  // intel facts extraction
  intelFacts: "openai/gpt-4o-mini",
  heatTriage: "openai/gpt-4o-mini",
  signals: "openai/gpt-4o-mini",
} as const;

export type ModelDomain = keyof typeof MODEL_REGISTRY;

export function getModelFor(domain: ModelDomain): string {
  return MODEL_REGISTRY[domain];
}

export function getModelForDomain(domain: ModelDomain): { model: string } {
  return { model: getModelFor(domain) };
}

export async function callLLM<T = unknown>(
  domain: ModelDomain,
  payload: ChatCompletionRequest
): Promise<T> {
  const model = getModelFor(domain);
  return callOpenRouter<T>(payload, { model });
}

// Backwards-friendly alias
export function getModelName(domain: ModelDomain): string {
  return getModelFor(domain);
}
