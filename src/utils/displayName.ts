// Helper to choose the best available display name from a message record.
export function bestDisplayNameFromMessage(msg: any): string | null {
  const candidates = [
    msg?.displayName,
    msg?.savedName,
    msg?.pushname,
    msg?.participantName,
    msg?.participantId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

// Fallback name from chatId (shorten phone if possible)
export function fallbackNameFromChatId(chatId: string): string {
  if (!chatId) return "unknown";
  if (/@/.test(chatId)) return chatId.split("@")[0] || chatId;
  if (/^\d{6,}$/.test(chatId)) return `${chatId.slice(0, 3)}…${chatId.slice(-2)}`;
  return chatId;
}
