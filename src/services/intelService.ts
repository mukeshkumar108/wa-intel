import { callLLM } from "../llm.js";
import { buildIntelFactsPrompt, toSummaryMessages } from "../prompts.js";
import {
  appendIntelFactsDedup,
  getRecentIntelFacts,
  IntelFactRecord,
  readIntelState,
  writeIntelState,
} from "../stores/intelFactsStore.js";
import {
  fetchActiveChats,
  fetchChatMessagesSince,
} from "../whatsappClient.js";

type DropReason = "missing_evidence" | "invalid_type" | "empty_summary";
type Correction = "type_coerced";

function sanitizeIntelFacts(
  chatId: string,
  facts: any[],
  messages: ReturnType<typeof toSummaryMessages>,
  chatMeta: { isGroup: boolean; chatDisplayName?: string | null },
  runType?: string
): { sanitized: IntelFactRecord[]; dropped: { reason: DropReason; fact: any }[]; corrections: Correction[] } {
  const allowedTypes = new Set(["EVENT", "EMOTION_CONCERN", "RELATIONSHIP_DYNAMIC"]);
  const allowedStatus = new Set(["event_claim", "self_report", "observed_pattern", "hypothesis"]);
  const allowedCertainty = new Set(["explicit", "implied", "unknown"]);
  const msgMap = new Map<string, { body: string; ts: number; fromMe: boolean; participantName?: string | null; participantId?: string | null }>();
  for (const m of messages) {
    msgMap.set(m.id, {
      body: m.body ?? "",
      ts: m.ts,
      fromMe: !!m.fromMe,
      participantName: (m as any).displayName ?? null,
      participantId: (m as any).participantId ?? null,
    });
  }

  const sanitized: IntelFactRecord[] = [];
  const dropped: { reason: DropReason; fact: any }[] = [];
  const corrections: Correction[] = [];

  for (const f of facts ?? []) {
    let type = typeof f?.type === "string" ? f.type : "";
    const status = typeof f?.epistemicStatus === "string" ? f.epistemicStatus : "";
    const summary = typeof f?.summary === "string" ? f.summary.trim() : "";
    const evidenceId = typeof f?.evidenceMessageId === "string" ? f.evidenceMessageId.trim() : "";
    const evidenceText = typeof f?.evidenceText === "string" ? f.evidenceText.trim() : "";
    const timeCertainty = allowedCertainty.has(f?.timeCertainty) ? f.timeCertainty : "unknown";
    const timeMention = typeof f?.timeMention === "string" && f.timeMention.trim().length ? f.timeMention.trim() : undefined;
    const whenRaw = typeof f?.when === "string" ? f.when : undefined;
    const whenDateRaw = typeof f?.whenDate === "string" ? f.whenDate : undefined;
    const signalScore = Number.isFinite(f?.signalScore) ? Number(f.signalScore) : undefined;
    let attributedTo: "ME" | "OTHER" | "UNKNOWN" = f?.attributedTo === "ME" || f?.attributedTo === "OTHER" ? f.attributedTo : "UNKNOWN";
    if (!summary) {
      dropped.push({ reason: "empty_summary", fact: f });
      continue;
    }
    if (!allowedTypes.has(type) || !allowedStatus.has(status)) {
      dropped.push({ reason: "invalid_type", fact: f });
      continue;
    }
    const msg = msgMap.get(evidenceId);
    if (!msg || !evidenceText || !msg.body.includes(evidenceText)) {
      dropped.push({ reason: "missing_evidence", fact: f });
      continue;
    }
    // Attribution enforcement
    if (msg.fromMe) attributedTo = "ME";
    else if (!chatMeta.isGroup) attributedTo = "OTHER";
    // Signal filtering
    const isEventWithTime =
      type === "EVENT" && (timeCertainty === "explicit" || timeCertainty === "implied") && (whenRaw || whenDateRaw);
    if ((signalScore ?? 0) <= 1 && !isEventWithTime) continue;
    const affectionateShort =
      /\b(mi amor|amor|babe|baby|love|luv|xoxo)\b/i.test(evidenceText) || /😘|😍|❤️/.test(evidenceText);
    if ((evidenceText?.length ?? 0) < 6) {
      if (!(affectionateShort && type === "RELATIONSHIP_DYNAMIC" && (signalScore ?? 0) >= 3)) {
        if (!((signalScore ?? 0) >= 4 && type === "RELATIONSHIP_DYNAMIC")) continue;
      }
    }
    const fullBody = msg.body ?? "";
    // Type sanity for affectionate/short texts or generic questions
    const affectionate =
      /\b(mi amor|amor|babe|baby|luv|xoxo|aw+|aww+)\b/i.test(evidenceText) || /😘|😍|❤️/.test(evidenceText);
    if (affectionate && type === "EVENT") {
      type = "RELATIONSHIP_DYNAMIC";
      corrections.push("type_coerced");
    }
    const isQuestion =
      /\?\s*$/.test(fullBody) ||
      /\b(how (are|r) you|what'?s on your mind|what projects are you working on)\b/i.test(fullBody);
    if (isQuestion && type === "EVENT") {
      type = "RELATIONSHIP_DYNAMIC";
      corrections.push("type_coerced");
    }
    const trivial =
      /\b(loo|toilet|bathroom|pee|poop|shower|showering|toilette|brb)\b/i.test(fullBody) ||
      /\b(aww+|lol|haha)\b/i.test(evidenceText) ||
      /\b(karate|video call|vid call|vc)\b/i.test(fullBody);
    if (trivial && type === "EVENT") {
      corrections.push("type_coerced");
      continue;
    }
    const statusBusy = /\b(busy|slammed|swamped|engrossed|heads? down|working on projects?)\b/i.test(fullBody);
    const stressy = /\b(stress|stressed|overwhelmed|tired|exhausted|drained|burnt|burned out|anxious)\b/i.test(fullBody);
    if (type === "EVENT" && statusBusy) {
      if (stressy) {
        type = "EMOTION_CONCERN";
        corrections.push("type_coerced");
      } else {
        corrections.push("type_coerced");
        continue;
      }
    }
    // Group gate: drop if group and not fromMe and not pinned/mentioned
    if (chatMeta.isGroup && !msg.fromMe) {
      const pinned = (process.env.INTEL_PINNED_CHATS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(chatId);
      const mentionsMe = /@me\b/i.test(fullBody);
      if (!pinned && !mentionsMe) continue;
    }
    sanitized.push({
      chatId,
      chatDisplayName: chatMeta.chatDisplayName,
      isGroup: chatMeta.isGroup,
      type,
      epistemicStatus: status as any,
      summary,
      entities: Array.isArray(f?.entities) ? f.entities.filter((x: any) => typeof x === "string") : [],
      timeCertainty,
      timeMention: timeMention ?? null,
      when: timeCertainty === "explicit" || timeCertainty === "implied" ? whenRaw : undefined,
      whenDate: timeCertainty === "explicit" || timeCertainty === "implied" ? whenDateRaw : undefined,
      attributedTo,
      signalScore,
      evidenceMessageId: evidenceId,
      evidenceText,
      ts: msg.ts,
      runType,
      storedAt: Date.now(),
    });
  }
  return { sanitized, dropped, corrections };
}

export async function bootstrapIntel(opts: {
  hours: number;
  limitChats: number;
  limitPerChat: number;
  includeGroups: boolean;
  runType?: string;
}) {
  const { hours, limitChats, limitPerChat, includeGroups, runType } = opts;
  const sinceTs = Date.now() - hours * 60 * 60 * 1000;
  const chats = (await fetchActiveChats(limitChats, includeGroups)).filter((c) =>
    includeGroups ? true : !c.chatId.endsWith("@g.us")
  );
  let chatsProcessed = 0;
  let messagesProcessed = 0;
  let factsWritten = 0;
  let factsDeduped = 0;
  let factsCorrected = 0;
  const dropReasons: Record<string, number> = {};
  const state = await readIntelState();
  state.lastBootstrapRunAt = Date.now();
  state.bootstrapSinceTs = sinceTs;
  state.byChat = state.byChat ?? {};
  const chatScores: Record<
    string,
    {
      factCount: number;
      messagesProcessed: number;
      emotionCount: number;
      relationshipCount: number;
      eventCount: number;
      avgSignalScore: number;
      groupNoisePenalty: number;
      chatIntelScore: number;
      chatDisplayName?: string | null;
      isGroup?: boolean;
    }
  > = {};

  for (const chat of chats) {
    const chatId = chat.chatId;
    const rawMessages = await fetchChatMessagesSince(chatId, sinceTs, limitPerChat).catch(() => []);
    messagesProcessed += rawMessages.length;
    if (!rawMessages.length) continue;
    const messages = toSummaryMessages(rawMessages);
    const prompt = buildIntelFactsPrompt({
      chatId,
      messages,
      hours,
      isGroup: !!chat.isGroup,
      chatDisplayName: chat.displayName,
      mode: "bootstrap",
    });
    let facts: any[] = [];
    try {
      const resp = await callLLM<{ facts?: any[] }>("intelFacts", prompt);
      facts = resp?.facts ?? [];
    } catch (err) {
      console.error("[intel] LLM failure", { chatId, err });
      continue;
    }
    const { sanitized, dropped, corrections } = sanitizeIntelFacts(
      chatId,
      facts,
      messages,
      { isGroup: !!chat.isGroup, chatDisplayName: chat.displayName },
      runType
    );
    factsCorrected += corrections.length;
    if (sanitized.length) {
      const writeResult = await appendIntelFactsDedup(sanitized);
      factsWritten += writeResult.written;
      factsDeduped += writeResult.deduped;
    }
    for (const d of dropped) {
      dropReasons[d.reason] = (dropReasons[d.reason] ?? 0) + 1;
    }
    chatsProcessed++;
    const maxTs = Math.max(...rawMessages.map((m) => m.ts));
    state.byChat![chatId] = { lastProcessedTs: maxTs };
    // scoring
    const emotionCount = sanitized.filter((f) => f.type === "EMOTION_CONCERN").length;
    const relationshipCount = sanitized.filter((f) => f.type === "RELATIONSHIP_DYNAMIC").length;
    const eventCount = sanitized.filter((f) => f.type === "EVENT").length;
    const avgSignalScore =
      sanitized.reduce((a, b) => a + (b.signalScore ?? 0), 0) / (sanitized.length || 1);
    const groupNoisePenalty =
      chat.isGroup && sanitized.length < 1 && rawMessages.length > 0 ? 1 : 0;
    const chatIntelScore =
      eventCount * 3 +
      emotionCount * 2 +
      relationshipCount * 2 +
      avgSignalScore +
      (chat.isGroup ? -groupNoisePenalty : 0);
    chatScores[chatId] = {
      factCount: sanitized.length,
      messagesProcessed: rawMessages.length,
      emotionCount,
      relationshipCount,
      eventCount,
      avgSignalScore,
      groupNoisePenalty,
      chatIntelScore,
      chatDisplayName: chat.displayName,
      isGroup: !!chat.isGroup,
    };
    if (process.env.DEBUG_INTEL === "1") {
      console.info("[intel] chat", {
        chatId,
        msgs: rawMessages.length,
        factsRaw: facts.length,
        factsKept: sanitized.length,
        dropped: dropped.length,
      });
    }
  }

  await writeIntelState({ ...state, chatScores });

  const topChats = Object.entries(state.byChat ?? {})
    .map(([id]) => ({ id, score: chatScores[id]?.chatIntelScore ?? 0 }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);

  return {
    chatsProcessed,
    messagesProcessed,
    factsWritten,
    factsDeduped,
    factsCorrected,
    factsDropped: Object.values(dropReasons).reduce((a, b) => a + b, 0),
    dropReasonsCount: dropReasons,
    topChats,
  };
}

export async function recentIntelFacts(limit = 50) {
  return getRecentIntelFacts(limit);
}
