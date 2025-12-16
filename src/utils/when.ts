const TIME_TOKENS = /\b(\d{1,2}:\d{2}\b|\d{1,2}\s?(am|pm)\b|noon|midnight|\btonight\b.*\bat\b)/i;
const DATE_ONLY_WORDS = /\b(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|next monday|next tuesday|next wednesday|next thursday|next friday|next saturday|next sunday)\b/i;

function hasExplicitTimeHint(text: string): boolean {
  return TIME_TOKENS.test(text);
}

function formatDateLondon(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

export function normalizeWhen(inputWhen?: string | null, inputWhenDate?: string | null, evidenceText?: string | null): { when: string | null; whenDate: string | null; hasTime: boolean } {
  const rawWhen = (inputWhen ?? "").trim();
  const rawWhenDate = (inputWhenDate ?? "").trim();
  const rawEvidence = (evidenceText ?? "").trim();
  const text = `${rawWhen} ${rawWhenDate} ${rawEvidence}`.trim();

  if (!text) return { when: null, whenDate: null, hasTime: false };

  const hasTimeHint = hasExplicitTimeHint(text);

  if (hasTimeHint) {
    const parsed = Date.parse(rawWhen || rawEvidence || text);
    if (!Number.isNaN(parsed)) {
      const dt = new Date(parsed);
      const whenDate = formatDateLondon(dt);
      const isMidnight = dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0;
      if (isMidnight && !TIME_TOKENS.test(rawWhen)) {
        return { when: null, whenDate, hasTime: false };
      }
      return { when: dt.toISOString(), whenDate, hasTime: !isMidnight };
    }
    return { when: null, whenDate: null, hasTime: false };
  }

  if (rawWhenDate) {
    const parsed = Date.parse(rawWhenDate);
    if (!Number.isNaN(parsed)) {
      const dt = new Date(parsed);
      return { when: null, whenDate: formatDateLondon(dt), hasTime: false };
    }
  }
  if (DATE_ONLY_WORDS.test(text)) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) {
      const dt = new Date(parsed);
      return { when: null, whenDate: formatDateLondon(dt), hasTime: false };
    }
  }

  const parsed = Date.parse(rawWhen);
  if (!Number.isNaN(parsed)) {
    const dt = new Date(parsed);
    return { when: null, whenDate: formatDateLondon(dt), hasTime: false };
  }

  return { when: null, whenDate: null, hasTime: false };
}
