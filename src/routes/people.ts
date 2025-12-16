import { Router } from "express";
import { z } from "zod";
import { fetchRecentMessages } from "../whatsappClient.js";
import { MessageRecord } from "../types.js";
import { bestDisplayNameFromMessage, fallbackNameFromChatId } from "../utils/displayName.js";

export const peopleRouter = Router();

const daysSchema = z
  .string()
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n) && n > 0 && n <= 365, {
    message: "days must be between 1 and 365",
  });

const limitSchema = z
  .string()
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n) && n > 0 && n <= 200, {
    message: "limit must be between 1 and 200",
  });

export type PersonSummary = {
  chatId: string;
  displayName: string;
  lastMessageTs: number;
  messageCount: number;
};

function isGroupOrBroadcast(chatId: string): boolean {
  // WhatsApp group chats usually end with '@g.us'
  if (chatId.endsWith("@g.us")) return true;

  // Broadcast lists / status / channels often use '@broadcast'
  if (chatId.includes("@broadcast")) return true;

  // Add any other patterns you want to exclude here if they show up in your data.
  return false;
}

function inferDisplayName(msgs: MessageRecord[]): string | null {
  // Prefer the most recent non-empty best display name from incoming messages (excluding fromMe).
  const sorted = [...msgs].filter((m) => !m.fromMe).sort((a, b) => b.ts - a.ts);
  for (const m of sorted) {
    const name = bestDisplayNameFromMessage(m);
    if (name) return name;
  }
  return null;
}

export async function getRecentOneToOneChats(
  days: number,
  limit?: number
): Promise<{ people: PersonSummary[]; totalFound: number }> {
  const now = Date.now();
  const cutoffTs = now - days * 24 * 60 * 60 * 1000;

  // Pull a window of recent messages and filter locally by timestamp.
  const rawMessages = await fetchRecentMessages(1000);

  const byChat = new Map<string, MessageRecord[]>();

  for (const m of rawMessages) {
    if (!m.chatId) continue;
    if (isGroupOrBroadcast(m.chatId)) continue;
    if (m.ts < cutoffTs) continue;

    let list = byChat.get(m.chatId);
    if (!list) {
      list = [];
      byChat.set(m.chatId, list);
    }
    list.push(m);
  }

  const people: PersonSummary[] = [];

  for (const [chatId, msgs] of byChat.entries()) {
    if (msgs.length === 0) continue;

    let lastMessageTs = 0;
    for (const msg of msgs) {
      if (msg.ts > lastMessageTs) lastMessageTs = msg.ts;
    }

    const displayName = inferDisplayName(msgs) ?? fallbackNameFromChatId(chatId);

    people.push({
      chatId,
      displayName,
      lastMessageTs,
      messageCount: msgs.length,
    });
  }

  people.sort((a, b) => b.lastMessageTs - a.lastMessageTs);

  const totalFound = people.length;
  const limited = typeof limit === "number" ? people.slice(0, limit) : people;

  return { people: limited, totalFound };
}

// Deprecated; replaced by snapshots-backed listings. Kept for compatibility.
peopleRouter.get("/relationships/people", async (req, res) => {
  try {
    const daysStr = (req.query.days as string | undefined) ?? "30";
    const limitStr = (req.query.limit as string | undefined) ?? "50";

    const days = daysSchema.parse(daysStr);
    const limit = limitSchema.parse(limitStr);

    const { people } = await getRecentOneToOneChats(days, limit);

    res.json({ people });
  } catch (err: any) {
    console.error("Error in /relationships/people:", err?.message ?? err);
    res.status(500).json({ error: "Failed to list people" });
  }
});

// Deprecated; replaced by snapshots-backed listings. Kept for compatibility.
peopleRouter.get("/relationships/list", async (req, res) => {
  try {
    const daysStr = (req.query.days as string | undefined) ?? "30";
    const limitStr = (req.query.limit as string | undefined) ?? "50";

    const days = daysSchema.parse(daysStr);
    const limit = limitSchema.parse(limitStr);

    const { people: relationships } = await getRecentOneToOneChats(days, limit);

    res.json({ relationships });
  } catch (err: any) {
    console.error("Error in /relationships/list:", err?.message ?? err);
    res.status(500).json({ error: "Failed to list relationships" });
  }
});
