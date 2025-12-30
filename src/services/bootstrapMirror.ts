import { fetchServiceStatus, fetchChatMessagesBefore, fetchActiveChats } from "../whatsappClient.js";
import { saveMessages } from "./dataPersistence.js";
import { pool } from "../db.js";
import { saveArtifact, startRun, finishRun } from "./intelPersistence.js";

const BOOTSTRAP_MIRROR = String(process.env.BOOTSTRAP_MIRROR ?? "false").toLowerCase() === "true";
const BOOTSTRAP_LIMIT_CHATS = Number(process.env.BOOTSTRAP_MIRROR_LIMIT_CHATS ?? 2000) || 2000;
const BOOTSTRAP_PER_CHAT = Number(process.env.BOOTSTRAP_MIRROR_PER_CHAT ?? 500) || 500;
const BOOTSTRAP_TIMEOUT_MS = Number(process.env.BOOTSTRAP_MIRROR_TIMEOUT_MS ?? 120000) || 120000;

let started = false;

async function waitForServiceAReady(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await fetchServiceStatus();
      if (status?.startupInfillStatus === "done") return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export async function runBootstrapMirrorIfNeeded() {
  if (started) return;
  started = true;
  if (!BOOTSTRAP_MIRROR) return;
  try {
    const existing = await pool.query("SELECT COUNT(*) AS chats, (SELECT COUNT(*) FROM messages) AS msgs FROM (SELECT DISTINCT chat_id FROM messages) t");
    const chatCount = Number(existing.rows?.[0]?.chats ?? 0);
    const msgCount = Number(existing.rows?.[0]?.msgs ?? 0);
    if (chatCount > 0 || msgCount > 0) {
      console.info("[bootstrap-mirror] skipped (db_not_empty)", { chatCount, msgCount });
      return;
    }
  } catch (err) {
    console.error("[bootstrap-mirror] db check failed", err);
    return;
  }

  const ready = await waitForServiceAReady(BOOTSTRAP_TIMEOUT_MS);
  if (!ready) {
    console.error("[bootstrap-mirror] timeout waiting for Service A startup infill");
    return;
  }

  const runId = await startRun({ kind: "bootstrap_mirror_run", runType: "manual", params: { limitChats: BOOTSTRAP_LIMIT_CHATS, perChat: BOOTSTRAP_PER_CHAT } });
  const startTs = Date.now();
  let serviceAChatsSeen = 0;
  let serviceAGroupChatsSeen = 0;
  let chatsHydrated = 0;
  let messagesFetched = 0;
  let messagesInserted = 0;
  let messagesDeduped = 0;
  const errorsByChat: Record<string, string> = {};
  const hydrationMetrics: any[] = [];

  try {
    const svcChats = await fetchActiveChats(BOOTSTRAP_LIMIT_CHATS, true);
    const chatIds = Array.from(new Set((svcChats ?? []).map((c) => c.chatId).filter(Boolean))).slice(0, BOOTSTRAP_LIMIT_CHATS);
    serviceAChatsSeen = chatIds.length;
    serviceAGroupChatsSeen = chatIds.filter((c) => c.endsWith("@g.us")).length;

    for (const chatId of chatIds) {
      try {
        const { messages } = await fetchChatMessagesBefore(chatId, Date.now(), BOOTSTRAP_PER_CHAT).catch(() => ({ messages: [] as any[] }));
        if (!messages?.length) continue;
        messagesFetched += messages.length;
        const ids = Array.from(new Set(messages.map((m: any) => m.id).filter(Boolean)));
        let existing = 0;
        if (ids.length) {
          const existingRes = await pool.query("SELECT COUNT(*) AS cnt FROM messages WHERE id = ANY($1)", [ids]);
          existing = Number(existingRes.rows?.[0]?.cnt ?? 0);
        }
        const inserted = Math.max(0, ids.length - existing);
        messagesInserted += inserted;
        messagesDeduped += Math.max(0, ids.length - inserted);
        await saveMessages(chatId, messages as any);
        chatsHydrated++;
        hydrationMetrics.push({
          chatId,
          fetched: messages.length,
          inserted,
          deduped: Math.max(0, ids.length - inserted),
          dropped: 0,
          droppedReasons: [],
        });
      } catch (err: any) {
        errorsByChat[chatId] = err?.message ?? String(err);
      }
    }

    const payload = {
      ok: true,
      serviceAChatsSeen,
      serviceAGroupChatsSeen,
      chatsAttempted: serviceAChatsSeen,
      chatsHydrated,
      messagesFetched,
      messagesInserted,
      messagesDeduped,
      dropped: 0,
      droppedReasons: [],
      errorsByChat: { count: Object.keys(errorsByChat).length, sample: Object.entries(errorsByChat).slice(0, 5) },
      hydrationMetrics,
      durationMs: Date.now() - startTs,
    };
    await saveArtifact({ runId, artifactType: "bootstrap_mirror_result", payload });
    await finishRun(runId, { status: "ok" });
    console.info("[bootstrap-mirror] ok", {
      chatsSeen: serviceAChatsSeen,
      chatsHydrated,
      msgsFetched: messagesFetched,
      inserted: messagesInserted,
      deduped: messagesDeduped,
      dropped: 0,
    });
  } catch (err: any) {
    await finishRun(runId, { status: "error", error: err?.message ?? String(err) });
    console.error("[bootstrap-mirror] failed", err);
  }
}
