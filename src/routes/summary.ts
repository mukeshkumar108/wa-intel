import { Router } from "express";
import { z } from "zod";
import { fetchRecentMessages, fetchChatMessages } from "../whatsappClient.js";
import { callLLM } from "../llm.js";
import {
  buildSummaryPrompt,
  toSummaryMessages,
  ConversationSummary,
  SummaryRequestMessage,
  OpenLoopItem,
} from "../prompts.js";
import { IntelMeta } from "../types.js";

export const summaryRouter = Router();

const limitSchema = z
  .string()
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n) && n > 0 && n <= 500, {
    message: "limit must be between 1 and 500",
  });

function attachWhoToOpenLoops(
  summary: ConversationSummary,
  messages: SummaryRequestMessage[]
): ConversationSummary {
  const index = new Map<string, SummaryRequestMessage>();
  for (const m of messages) {
    index.set(m.id, m);
  }

  const fixedOpenLoops: OpenLoopItem[] = (summary.openLoops ?? []).map((loop) => {
    const msg = index.get(loop.messageId);
    let who = loop.who;

    if (msg) {
      if (msg.fromMe) {
        who = "me";
      } else {
        who = msg.displayName || "them";
      }
    } else if (!who) {
      who = "unknown";
    }

    return {
      ...loop,
      who,
    };
  });

  return {
    ...summary,
    openLoops: fixedOpenLoops,
  };
}

// GET /summary/recent?limit=<n>
summaryRouter.get("/summary/recent", async (req, res) => {
  try {
    const limitStr = (req.query.limit as string | undefined) ?? "100";
    const limit = limitSchema.parse(limitStr);

    const rawMessages = await fetchRecentMessages(limit);
    const messages = toSummaryMessages(rawMessages);
    messages.sort((a, b) => a.ts - b.ts); // oldest first

    const meta: IntelMeta = {
      messageCount: messages.length,
      fromTs: messages[0]?.ts ?? null,
      toTs: messages[messages.length - 1]?.ts ?? null,
    };

    if (messages.length === 0) {
      return res.json({
        summary: {
          narrativeSummary: "No recent messages.",
          keyPeople: [],
          keyTopics: [],
          openLoops: [],
        } as ConversationSummary,
        meta,
      });
    }

    const prompt = buildSummaryPrompt(messages);
    let summary = await callLLM<ConversationSummary>("summary", prompt);

    summary = attachWhoToOpenLoops(summary, messages);

    res.json({ summary, meta });
  } catch (err: any) {
    console.error("Error in /summary/recent:", err?.message ?? err);
    res.status(500).json({ error: "Failed to generate summary" });
  }
});

// GET /summary/chat/:chatId?limit=<n>
summaryRouter.get("/summary/chat/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const limitStr = (req.query.limit as string | undefined) ?? "200";
    const limit = limitSchema.parse(limitStr);

    const rawMessages = await fetchChatMessages(chatId, limit);
    const messages = toSummaryMessages(rawMessages);
    messages.sort((a, b) => a.ts - b.ts);

    const meta: IntelMeta = {
      messageCount: messages.length,
      fromTs: messages[0]?.ts ?? null,
      toTs: messages[messages.length - 1]?.ts ?? null,
    };

    if (messages.length === 0) {
      return res.json({
        summary: {
          narrativeSummary: "No messages found for this chat.",
          keyPeople: [],
          keyTopics: [],
          openLoops: [],
        } as ConversationSummary,
        meta,
      });
    }

    const prompt = buildSummaryPrompt(messages);
    let summary = await callLLM<ConversationSummary>("summary", prompt);

    summary = attachWhoToOpenLoops(summary, messages);

    res.json({ summary, meta });
  } catch (err: any) {
    console.error("Error in /summary/chat:", err?.message ?? err);
    res.status(500).json({ error: "Failed to generate chat summary" });
  }
});
