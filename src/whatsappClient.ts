import axios from "axios";
import { config } from "./config.js";
import { MessageRecord } from "./types.js";

const client = axios.create({
  baseURL: config.whatsappBase,
  timeout: 10_000,
});

// All calls to Service A are protected, so set the default Authorization header once.
client.defaults.headers.common["Authorization"] = `Bearer ${config.whatsappApiKey}`;

async function withRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const status = err?.response?.status;
    const retryable =
      !status ||
      status >= 500 ||
      status === 502 ||
      status === 503 ||
      status === 504;
    if (!retryable || attempt >= 3) {
      throw err;
    }
    const backoffMs = [250, 750, 1500][attempt - 1] ?? 1500;
    await new Promise((r) => setTimeout(r, backoffMs));
    return withRetry(fn, attempt + 1);
  }
}

function isTimeout(err: any): boolean {
  return err?.code === "ECONNABORTED" || /timeout/i.test(err?.message ?? "");
}

async function withTimeoutRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isTimeout(err)) {
      console.warn("[orchestrator] Service A call timeout, retrying once");
      await new Promise((r) => setTimeout(r, 500));
      return fn();
    }
    throw err;
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
  const res = await withRetry(() =>
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
  const res = await withRetry(() =>
    client.get(`/api/messages/chat/${encodeURIComponent(chatId)}`, {
      params: { limit, offset },
    })
  );

  const data = res.data as MessagesResponse | MessageRecord[];
  const messages = Array.isArray(data) ? data : data.messages;

  return messages ?? [];
}

export async function fetchMessagesSince(ts: number, limit = 2000): Promise<MessageRecord[]> {
  const res = await withRetry(() =>
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
  const res = await withRetry(() =>
    client.get("/api/contacts", {
      params: { limit },
    })
  );
  const data = res.data as { contacts?: ContactRecord[] } | ContactRecord[];
  const contacts = Array.isArray(data) ? data : data.contacts;
  return contacts ?? [];
}

export async function fetchMessagesBefore(ts: number, limit = 2000): Promise<FetchResult> {
  const res = await withRetry(() =>
    client.get("/api/messages/before", {
      params: { ts, limit },
    })
  );
  const data = res.data as MessagesResponse | MessageRecord[];
  const parsed = parseMessagesResponse(data);
  return parsed;
}

export async function fetchMessagesSinceWithMeta(ts: number, limit = 2000): Promise<FetchResult> {
  const res = await withRetry(() =>
    client.get("/api/messages/since", {
      params: { ts, limit },
    })
  );
  const data = res.data as MessagesResponse | MessageRecord[];
  return parseMessagesResponse(data);
}

type ActiveChat = { chatId: string; isGroup?: boolean; displayName?: string | null; messageCount?: number | null };

export async function fetchActiveChats(limit = 50, includeGroups = false): Promise<ActiveChat[]> {
  const res = await withRetry(() =>
    client.get("/api/chats/active", {
      params: { limit, includeGroups },
    })
  );
  const data = res.data as { chats?: ActiveChat[] } | ActiveChat[];
  const chats = Array.isArray(data) ? data : data.chats;
  return chats ?? [];
}

export async function fetchChatMessagesSince(chatId: string, ts: number, limit = 200): Promise<MessageRecord[]> {
  const res = await withRetry(() =>
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
  const res = await withRetry(() =>
    client.get(`/api/messages/chat/${encodeURIComponent(chatId)}/before`, {
      params: { ts, limit },
    })
  );
  const data = res.data as MessagesResponse | MessageRecord[];
  return parseMessagesResponse(data);
}

export async function fetchServiceStatus(): Promise<any> {
  const res = await withTimeoutRetry(() =>
    client.get("/status", {
      timeout: 60_000,
    })
  );
  return res.data;
}

export interface CoverageStatus {
  directCoveragePct?: number;
  topChats?: { chatId: string; targetMessages?: number }[];
  [key: string]: any;
}

export async function getCoverageStatus(): Promise<CoverageStatus> {
  const res = await withTimeoutRetry(() =>
    client.get("/api/coverage/status", {
      timeout: 60_000,
    })
  );
  return res.data as CoverageStatus;
}

export async function setBackfillTargets(targets: { chatId: string; targetMessages: number }[]): Promise<void> {
  await withTimeoutRetry(() =>
    client.post(
      "/api/backfill/targets",
      {
        targets,
      },
      { timeout: 60_000 }
    )
  );
}
