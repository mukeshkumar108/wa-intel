import { fetchChatMessages } from "../whatsappClient.js";
import { RelationshipSummary, RelationshipSnapshot } from "../types.js";
import {
  getRelationshipSnapshotsForChat,
  saveRelationshipSnapshot,
  getLatestRelationshipSnapshotForChat,
  getLatestSnapshots,
} from "../relationshipSnapshotsStore.js";
import { buildRelationshipPrompt, toSummaryMessages } from "../prompts.js";
import { callLLM, getModelName } from "../llm.js";
import { getRecentOneToOneChats } from "../routes/people.js";
import { computeRelationshipMetrics, normalizeRelationshipModel, inferDisplayName } from "../routes/relationships.js";

export async function generateRelationshipSnapshot(
  chatId: string,
  opts?: { limit?: number; force?: boolean }
): Promise<RelationshipSnapshot> {
  const force = !!opts?.force;
  const limit = opts?.limit ?? 300;

  if (!force) {
    const latest = await getLatestRelationshipSnapshotForChat(chatId);
    if (latest) return latest;
  }

  const rawMessages = await fetchChatMessages(chatId, limit);
  rawMessages.sort((a, b) => a.ts - b.ts);
  const windowMessages = rawMessages.slice(-limit);

  const metrics = computeRelationshipMetrics(windowMessages, Date.now());
  const messages = toSummaryMessages(windowMessages);
  messages.sort((a, b) => a.ts - b.ts);

  if (messages.length === 0) {
    throw new Error("No messages found for this chat");
  }

  const inferredName = inferDisplayName(messages);
  const prompt = buildRelationshipPrompt(messages, chatId, inferredName);
  let summary: RelationshipSummary;
  try {
    summary = await callLLM<RelationshipSummary>("relationship", prompt);
  } catch (err) {
    console.error("[relationshipSnapshot] LLM call failed", {
      model: getModelName("relationship"),
      chatId,
      error: (err as Error)?.message ?? err,
    });
    throw err;
  }

  const firstMessageTs = summary.firstMessageTs ?? messages[0]?.ts ?? null;
  const lastMessageTs = summary.lastMessageTs ?? messages[messages.length - 1]?.ts ?? null;
  const normalizedModel = normalizeRelationshipModel(summary.model);

  const relationship: RelationshipSummary = {
    ...summary,
    chatId,
    displayName: summary.displayName ?? inferredName ?? null,
    firstMessageTs,
    lastMessageTs,
    metrics,
    model: normalizedModel,
  };

  const snapshot: RelationshipSnapshot = {
    chatId,
    snapshotTs: Date.now(),
    window: {
      fromTs: messages[0]?.ts ?? null,
      toTs: messages[messages.length - 1]?.ts ?? null,
    },
    summary: {
      overallSummary: relationship.overallSummary,
      keyTopics: relationship.keyTopics ?? [],
    },
    metrics,
    model: normalizedModel!,
    lastMessageTs,
    messageCount: metrics.totalMessages,
    modelUsed: getModelName("relationship"),
  };

  await saveRelationshipSnapshot(snapshot);
  return snapshot;
}

export async function getLatestRelationshipSnapshot(chatId: string) {
  return getLatestRelationshipSnapshotForChat(chatId);
}

export async function getTopRelationshipsFromSnapshots(
  days: number,
  limit: number
): Promise<RelationshipSnapshot[]> {
  // days retained for API symmetry; currently selecting latest snapshots up to limit
  return getLatestSnapshots(limit);
}
