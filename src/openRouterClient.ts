import { config } from "./config.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? config.openRouterApiKey;
const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER ?? "pedrito-local";
const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE ?? "pedrito-intel";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? config.openRouterModel;

if (!OPENROUTER_API_KEY) {
  throw new Error("Missing OPENROUTER_API_KEY");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
}

export async function callOpenRouter<T = unknown>(
  payload: ChatCompletionRequest,
  opts?: { model?: string }
): Promise<T> {
  const model = opts?.model ?? DEFAULT_MODEL;
  const res = await fetch(OPENROUTER_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": OPENROUTER_TITLE,
    },
    body: JSON.stringify({
      model,
      ...payload,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "no body");
    throw new Error(`OpenRouter request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;

  if (!content) {
    throw new Error("No content from OpenRouter");
  }

  try {
    return JSON.parse(content) as T;
  } catch (err) {
    const match = content.match(/\{[\s\S]*\}$/);
    if (!match) throw new Error("Failed to parse JSON from LLM response");
    return JSON.parse(match[0]) as T;
  }
}
