import { pool } from "../db.js";

type StoredMessage = {
  id: string;
  chatId: string;
  sender: string | null;
  content: string | null;
  ts: number | null;
  role: string | null;
};

export async function getRecentMessages(chatId: string, limit: number): Promise<StoredMessage[]> {
  if (!chatId || !Number.isFinite(limit) || limit <= 0) return [];
  try {
    const res = await pool.query(
      `SELECT id, chat_id, sender, content, ts, role
       FROM messages
       WHERE chat_id = $1
       ORDER BY ts DESC
       LIMIT $2`,
      [chatId, limit]
    );
    return (res.rows ?? []).map((r: any) => ({
      id: r.id,
      chatId: r.chat_id ?? r.chatId,
      sender: r.sender ?? null,
      content: r.content ?? null,
      ts: r.ts !== null && r.ts !== undefined ? Number(r.ts) : null,
      role: r.role ?? null,
    }));
  } catch (err) {
    console.error("[messageStore] getRecentMessages failed", err);
    return [];
  }
}

export async function getMessageCount(chatId: string): Promise<number> {
  if (!chatId) return 0;
  try {
    const res = await pool.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = $1", [chatId]);
    const n = Number(res.rows?.[0]?.count ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.error("[messageStore] getMessageCount failed", err);
    return 0;
  }
}

export async function getActiveChats(limit: number): Promise<{ chatId: string; latestTs: number | null; messageCount: number }[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  try {
    const res = await pool.query(
      `
      SELECT chat_id, MAX(ts) AS latest_ts, COUNT(*) AS message_count
      FROM messages
      GROUP BY chat_id
      ORDER BY latest_ts DESC
      LIMIT $1
      `,
      [limit]
    );
    return (res.rows ?? []).map((r: any) => ({
      chatId: r.chat_id ?? r.chatId,
      latestTs: r.latest_ts !== null && r.latest_ts !== undefined ? Number(r.latest_ts) : null,
      messageCount: Number(r.message_count ?? 0),
    }));
  } catch (err) {
    console.error("[messageStore] getActiveChats failed", err);
    return [];
  }
}

export async function getThinChats(threshold: number, limit: number): Promise<{ chatId: string; messageCount: number; latestTs: number | null }[]> {
  if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(limit) || limit <= 0) return [];
  try {
    const res = await pool.query(
      `
      SELECT chat_id, COUNT(*) AS message_count, MAX(ts) AS latest_ts
      FROM messages
      GROUP BY chat_id
      HAVING COUNT(*) > 0 AND COUNT(*) < $1
      ORDER BY message_count ASC, latest_ts DESC
      LIMIT $2
      `,
      [threshold, limit]
    );
    return (res.rows ?? []).map((r: any) => ({
      chatId: r.chat_id ?? r.chatId,
      messageCount: Number(r.message_count ?? 0),
      latestTs: r.latest_ts !== null && r.latest_ts !== undefined ? Number(r.latest_ts) : null,
    }));
  } catch (err) {
    console.error("[messageStore] getThinChats failed", err);
    return [];
  }
}

export type FlatMessage = {
  id: string;
  chatId: string;
  ts: number;
  fromMe: boolean;
  body: string | null;
  role?: string | null;
  type?: string | null;
};

export async function getRecentMessagesSince(
  sinceTs: number,
  recentLimit: number,
  includeGroups: boolean
): Promise<FlatMessage[]> {
  if (!Number.isFinite(recentLimit) || recentLimit <= 0) return [];
  try {
    const res = await pool.query(
      `
      SELECT id, chat_id, sender, content, ts, role
      FROM messages
      WHERE ts >= $1
      ORDER BY ts DESC
      LIMIT $2
      `,
      [sinceTs, recentLimit]
    );
    return (res.rows ?? [])
      .map((r: any) => ({
        id: r.id,
        chatId: r.chat_id ?? r.chatId,
        ts: Number(r.ts ?? 0),
        fromMe: (r.role ?? "").toLowerCase() === "me",
        body: typeof r.content === "string" ? r.content : null,
        role: r.role ?? null,
        type: "chat",
      }))
      .filter((m) => {
        if (!m.chatId) return false;
        if (!includeGroups && m.chatId.endsWith("@g.us")) return false;
        if (m.chatId === "status@broadcast" || m.chatId.includes("@broadcast") || m.chatId.endsWith("@lid")) return false;
        return true;
      });
  } catch (err) {
    console.error("[messageStore] getRecentMessagesSince failed", err);
    return [];
  }
}

export async function getChatMessagesSince(
  chatId: string,
  sinceTs: number,
  limit: number
): Promise<FlatMessage[]> {
  if (!chatId || !Number.isFinite(limit) || limit <= 0) return [];
  try {
    const res = await pool.query(
      `
      SELECT id, chat_id, sender, content, ts, role
      FROM messages
      WHERE chat_id = $1 AND ts >= $2
      ORDER BY ts ASC
      LIMIT $3
      `,
      [chatId, sinceTs, limit]
    );
    return (res.rows ?? []).map((r: any) => ({
      id: r.id,
      chatId: r.chat_id ?? r.chatId,
      ts: Number(r.ts ?? 0),
      fromMe: (r.role ?? "").toLowerCase() === "me",
      body: typeof r.content === "string" ? r.content : null,
      role: r.role ?? null,
      type: "chat",
    }));
  } catch (err) {
    console.error("[messageStore] getChatMessagesSince failed", err);
    return [];
  }
}

export async function getHighHeatChats(limit: number): Promise<{ chatId: string; heatTier?: string; heatScore?: number }[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  try {
    const res = await pool.query(
      `
      SELECT payload
      FROM intel_artifacts
      WHERE artifact_type = 'heat_triage_result'
      ORDER BY id DESC
      LIMIT 1
      `
    );
    const row = res.rows?.[0];
    if (!row?.payload) return [];
    const results = Array.isArray(row.payload?.results) ? row.payload.results : Array.isArray(row.payload) ? row.payload : [];
    const highs = results
      .filter((r: any) => r?.chatId && (r?.heatTier === "HIGH" || (r?.heatScore ?? 0) >= 7))
      .slice(0, limit)
      .map((r: any) => ({
        chatId: r.chatId,
        heatTier: r.heatTier ?? null,
        heatScore: Number.isFinite(r?.heatScore) ? Number(r.heatScore) : null,
      }));
    return highs;
  } catch (err) {
    console.error("[messageStore] getHighHeatChats failed", err);
    return [];
  }
}
