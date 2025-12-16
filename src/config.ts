import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  whatsappBase: requireEnv("WHATSAPP_BASE"),
  whatsappApiKey: requireEnv("WHATSAPP_API_KEY"),
  openRouterApiKey: requireEnv("OPENROUTER_API_KEY"),
  openRouterModel: process.env.OPENROUTER_MODEL ?? "openai/gpt-4.1-mini",
};

export function getUserTimezoneOffsetHours(): number {
  const raw = process.env.USER_TZ_OFFSET_HOURS;
  if (!raw) return 0;
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  return Math.max(-12, Math.min(14, n));
}
