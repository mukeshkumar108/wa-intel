import { pool } from "../db.js";

const dualWriteEnabled = String(process.env.OPEN_LOOPS_DUAL_WRITE ?? "false").toLowerCase() === "true";

type IngestMessage = {
  id?: string;
  chatId?: string;
  senderId?: string | null;
  displayName?: string | null;
  fromMe?: boolean;
  body?: string | null;
  ts?: number; // epoch ms preferred; if seconds, we’ll detect and scale
};

export async function saveMessages(chatId: string, messages: IngestMessage[]): Promise<void> {
  if (!dualWriteEnabled) return;
  if (!chatId || !Array.isArray(messages) || messages.length === 0) return;
  try {
    try {
      console.log("DEBUG MSG:", JSON.stringify(messages[0], null, 2));
    } catch {}
    const name =
      messages
        .map((m) => m.displayName)
        .filter((n): n is string => !!n && n.trim().length > 0)[0] ?? null;
    const msgCount = messages.length;

    await pool.query(
      `
      INSERT INTO chats (id, name, message_count)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE
        SET name = COALESCE(EXCLUDED.name, chats.name),
            message_count = GREATEST(chats.message_count, EXCLUDED.message_count),
            updated_at = now()
      `,
      [chatId, name, msgCount]
    );

    const values: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const m of messages) {
      if (!m?.id) continue;
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      const rawTs = (() => {
        const anyMsg: any = m as any;
        if (Number.isFinite(anyMsg?.ts)) return Number(anyMsg.ts);
        if (Number.isFinite(anyMsg?.timestamp)) return Number(anyMsg.timestamp);
        if (Number.isFinite(anyMsg?.t)) return Number(anyMsg.t);
        return null;
      })();
      const tsMs = rawTs !== null ? (rawTs < 2_000_000_000 ? Math.round(rawTs * 1000) : rawTs) : Date.now();
      params.push(
        m.id,
        chatId,
        m.senderId ?? m.displayName ?? (m.fromMe ? "me" : "them"),
        typeof m.body === "string" ? m.body : null,
        tsMs,
        m.fromMe === true ? "me" : "them"
      );
    }
    if (!values.length) return;

    const sql = `
      INSERT INTO messages (id, chat_id, sender, content, ts, role)
      VALUES ${values.join(",")}
      ON CONFLICT (id) DO UPDATE
        SET chat_id = EXCLUDED.chat_id,
            sender = EXCLUDED.sender,
            content = EXCLUDED.content,
            ts = EXCLUDED.ts,
            role = EXCLUDED.role
    `;
    await pool.query(sql, params);
  } catch (err) {
    console.error("[dataPersistence] saveMessages failed", err);
  }
}
