import axios from "axios";
import { config } from "./config.js";
import { MessageRecord } from "./types.js";

const SERVICE_A_TIMEOUT_MS = config.serviceATimeoutMs;
const SERVICE_A_MAX_RETRIES = 2;
const SERVICE_A_BACKOFF_MS = [200, 600];

const client = axios.create({
  baseURL: config.whatsappBase,
  timeout: SERVICE_A_TIMEOUT_MS,
});

// All calls to Service A are protected, so set the default Authorization header once.
client.defaults.headers.common["Authorization"] = `Bearer ${config.whatsappApiKey}`;

const transientCodes = new Set(["ECONNABORTED", "ECONNRESET", "ECONNREFUSED", "ENETDOWN", "ENETUNREACH", "EAI_AGAIN", "ETIMEDOUT"]);
export function isServiceATransientError(err: any): boolean {
  const status = err?.response?.status;
  if (status && status < 500) return false;
  const code = err?.code;
  if (code && transientCodes.has(code)) return true;
  const message = (err?.message ?? "").toLowerCase();
  if (message.includes("timeout")) return true;
  if (!status) return true;
  return status >= 500;
}

async function withServiceARetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (attempt >= SERVICE_A_MAX_RETRIES || !isServiceATransientError(err)) {
      throw err;
    }
    const backoffMs = SERVICE_A_BACKOFF_MS[Math.min(attempt, SERVICE_A_BACKOFF_MS.length - 1)] ?? 250;
    await new Promise((r) => setTimeout(r, backoffMs));
    return withServiceARetry(fn, attempt + 1);
  }
}

interface MessagesResponse {
  messages: MessageRecord[];
  total?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
  truncated?: boolean;
}

export type FetchResult = { messages: MessageRecord[]; total?: number; hasMore?: boolean; truncated?: boolean };

function parseMessagesResponse(data: MessagesResponse | MessageRecord[]): FetchResult {
  const messages = Array.isArray(data) ? data : data.messages;
  const total = Array.isArray(data) ? data.length : data.total;
  const hasMore = Array.isArray(data) ? false : data.hasMore;
  const truncated =
    (Array.isArray(data) ? false : data.truncated) ||
    (Array.isArray(data) ? messages.length === (data as any)?.limit : false) ||
    false;
  return { messages: messages ?? [], total, hasMore, truncated };
}

export async function fetchRecentMessages(limit: number): Promise<MessageRecord[]> {
  const res = await withServiceARetry(() =>
    client.get("/api/messages/recent", {
      params: { limit },
    })
  );

  const data = res.data as MessagesResponse | MessageRecord[];
  const { messages } = parseMessagesResponse(data);
  return messages;
}

export async function fetchChatMessages(
  chatId: string,
  limit: number,
  offset = 0
): Promise<MessageRecord[]> {
  const res = await withServiceARetry(() =>
    client.get(`/api/messages/chat/${encodeURIComponent(chatId)}`, {
      params: { limit, offset },
    })
  );

  const data = res.data as MessagesResponse | MessageRecord[];
  const messages = Array.isArray(data) ? data : data.messages;

  return messages ?? [];
}

export async function fetchMessagesSince(ts: number, limit = 2000): Promise<MessageRecord[]> {
  const res = await withServiceARetry(() =>
    client.get("/api/messages/since", {
      params: { ts, limit },
    })
  );

  const data = res.data as MessagesResponse | MessageRecord[];
  const { messages } = parseMessagesResponse(data);

  return messages;
}

type ContactRecord = {
  chatId: string;
  displayName?: string | null;
  pushname?: string | null;
  savedName?: string | null;
  isGroup?: boolean;
  lastMessageTs?: number | null;
  messageCount?: number | null;
};

export async function fetchContacts(limit = 500): Promise<ContactRecord[]> {
  const res = await withServiceARetry(() =>
    client.get("/api/contacts", {
      params: { limit },
    })
  );
  const data = res.data as { contacts?: ContactRecord[] } | ContactRecord[];
  const contacts = Array.isArray(data) ? data : data.contacts;
  return contacts ?? [];
}

export async function fetchMessagesBefore(ts: number, limit = 2000): Promise<FetchResult> {
  const res = await withServiceARetry(() =>
    client.get("/api/messages/before", {
      params: { ts, limit },
    })
  );
  const data = res.data as MessagesResponse | MessageRecord[];
  const parsed = parseMessagesResponse(data);
  return parsed;
}

export async function fetchMessagesSinceWithMeta(ts: number, limit = 2000): Promise<FetchResult> {
  const res = await withServiceARetry(() =>
    client.get("/api/messages/since", {
      params: { ts, limit },
    })
  );
  const data = res.data as MessagesResponse | MessageRecord[];
  return parseMessagesResponse(data);
}

type ActiveChat = { chatId: string; isGroup?: boolean; displayName?: string | null; messageCount?: number | null };

export async function fetchActiveChats(limit = 50, includeGroups = false): Promise<ActiveChat[]> {
  const res = await withServiceARetry(() =>
    client.get("/api/chats/active", {
      params: { limit, includeGroups },
    })
  );
  const data = res.data as { chats?: ActiveChat[] } | ActiveChat[];
  const chats = Array.isArray(data) ? data : data.chats;
  return chats ?? [];
}

export async function fetchChatMessagesSince(chatId: string, ts: number, limit = 200): Promise<MessageRecord[]> {
  const res = await withServiceARetry(() =>
    client.get(`/api/messages/chat/${encodeURIComponent(chatId)}/since`, {
      params: { ts, limit },
    })
  );
  const data = res.data as MessagesResponse | MessageRecord[];
  const { messages } = parseMessagesResponse(data);
  return messages ?? [];
}

export async function fetchChatMessagesBefore(
  chatId: string,
  ts: number,
  limit = 200
): Promise<FetchResult> {
  const res = await withServiceARetry(() =>
    client.get(`/api/messages/chat/${encodeURIComponent(chatId)}/before`, {
      params: { ts, limit },
    })
  );
  const data = res.data as MessagesResponse | MessageRecord[];
  return parseMessagesResponse(data);
}

export async function fetchServiceStatus(): Promise<any> {
  const res = await withServiceARetry(() => client.get("/status"));
  return res.data;
}

export interface CoverageStatus {
  directCoveragePct?: number;
  topChats?: { chatId: string; targetMessages?: number }[];
  [key: string]: any;
}

export async function getCoverageStatus(): Promise<CoverageStatus> {
  const res = await withServiceARetry(() => client.get("/api/coverage/status"));
  return res.data as CoverageStatus;
}

export async function setBackfillTargets(targets: { chatId: string; targetMessages: number }[]): Promise<void> {
  await withServiceARetry(() =>
    client.post(
      "/api/backfill/targets",
      {
        targets,
      },
      { timeout: SERVICE_A_TIMEOUT_MS }
    )
  );
}
