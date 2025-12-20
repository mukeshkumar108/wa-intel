import {
  ConversationSummary,
  OpenLoopItem,
  SummaryRequestMessage,
  MessageRecord,
  RelationshipSummary,
  DailyStateSnapshot,
} from "./types.js";
import { ChatCompletionRequest } from "./openRouterClient.js";

export type HeatTriageChatMessage = { id: string; iso: string; speaker: "ME" | "OTHER"; body: string };
export type HeatTriageChatSlice = {
  chatId: string;
  chatDisplayName: string;
  messages: HeatTriageChatMessage[];
};

export type OrchestratorHeatMessage = {
  speaker: "ME" | "OTHER";
  type: string;
  body: string;
  ts: number;
};

export type OrchestratorHeatChatSlice = {
  chatId: string;
  chatDisplayName: string;
  messages: OrchestratorHeatMessage[];
};

export type SignalsChat = {
  chatId: string;
  messageCount: number;
  messages: {
    ts: number;
    fromMe: boolean;
    body: string | null;
    type: string;
  }[];
};

// Convert raw messages from Service A into the slimmer shape we send to the LLM.
export function toSummaryMessages(raw: MessageRecord[]): SummaryRequestMessage[] {
  return raw
    .filter(
      (m) =>
        m.type === "chat" &&
        m.body !== null &&
        m.body.trim().length > 0
    )
    .map((m) => ({
      id: m.id,
      chatId: m.chatId,
      senderId: m.senderId,
      displayName: m.displayName,
      fromMe: m.fromMe,
      ts: m.ts,
      body: m.body!.trim(),
    }));
}

export function buildDailyStatePrompt(params: { date: string; messages: MessageRecord[] }) {
  const { date, messages } = params;

  const system = `
You are an analyst summarizing the user's emotional and mental state for a single day based ONLY on their WhatsApp messages.
Use neutral, third-person, non-clinical, non-judgemental language (e.g., "the user", "they"). Do NOT use "I" or "me". Do NOT diagnose.
Always respond in English only (translate source content as needed, keep names/proper nouns as-is).
Respond ONLY with valid JSON matching this shape:
{
  "date": string; // YYYY-MM-DD
  "fromTs": number;
  "toTs": number;
  "mood": "mostly_positive" | "mixed" | "mostly_negative" | "flat" | "unknown";
  "energyLevel": number;      // 0-100
  "stressLevel": number;      // 0-100
  "dominantConcerns": string[];
  "selfTalkTone": string[];
  "copingPatterns": string[];
  "underlyingThemes"?: string[];
  "notableMoments": {
    "ts": number;
    "summary": string; // 3rd-person, neutral (no diagnoses, no "I")
  }[];
  "primaryActors"?: {
    "chatId": string;
    "displayName": string;
    "role"?: "partner" | "friend" | "family" | "work" | "church" | "other";
    "weight"?: number;
  }[];
  "drivers"?: {
    "type": "positive" | "negative" | "mixed";
    "summary": string;
    "relatedChatIds"?: string[];
  }[];
}
Keep notableMoments concise (1–5). Focus on behaviour, expressed feelings, stressors, concerns, and coping. No mental health labels. Include actor attribution via primaryActors and drivers.
`.trim();

  const compactMessages = messages
    .map((m) => {
      const speaker = m.fromMe ? "user" : m.displayName || "other";
      const body = JSON.stringify(m.body ?? "").slice(1, -1);
      return `- [${new Date(m.ts).toISOString()}] chatId=${m.chatId} ${speaker}: ${body}`;
    })
    .join("\n");

  const user = `
Date: ${date}

Here is a list of WhatsApp messages for this date. Infer the DailyStateSnapshot.

Guidance:
- mood: mostly_positive | mixed | mostly_negative | flat | unknown
- energyLevel: 0-100 based on mentions of energy/tiredness/activity
- stressLevel: 0-100 based on stress/anxiety/overload references
- dominantConcerns: main recurring topics (money, health, relationship, work, family, logistics, etc.)
- selfTalkTone: how the user talks about themselves (self-compassionate, self-critical, hopeful, avoidant, etc.)
- copingPatterns: coping styles (seeking_support, numbing_out, problem_solving, escaping, etc.)
- underlyingThemes: optional deeper fears/concerns (neutral phrases)
- notableMoments: 1-5 key moments with ts + neutral summary (third-person)
- primaryActors: up to 3 people/chats (chatId + displayName) that most influenced the user's emotions today; include optional role (partner, friend, family, work, church, other) and rough weight 0-1.
- drivers: emotional drivers with type (positive/negative/mixed), short summary, and relatedChatIds when relevant.

Messages:
${compactMessages}

Return ONLY the JSON object, no markdown.
`.trim();

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

export function buildHeatTriagePrompt(chats: HeatTriageChatSlice[]): ChatCompletionRequest {
  const system = `You are a triage assistant. Your job is to route which chats deserve deeper backfill based on intimacy/relationship heat. Return strict JSON only. Do not hallucinate; if uncertain, choose LOW.`.trim();

  const chatSections = chats
    .map((chat, idx) => {
      const messages = chat.messages
        .map((m) => `- [${m.iso}] [id=${m.id}] ${m.speaker}: ${JSON.stringify(m.body)}`)
        .join("\n");
      return `Chat ${idx + 1}:\nchatId: ${chat.chatId}\nchatDisplayName: ${chat.chatDisplayName}\nMessages:\n${messages}`;
    })
    .join("\n\n");

  const user = `
You are classifying ME's 1:1 chats. ME = user. OTHER = the counterpart in the chat. Groups are already excluded.

For each chat, return an object with this exact schema:
{
  "chatId": string,
  "chatDisplayName": string,
  "heatTier": "LOW" | "MED" | "HIGH",
  "heatScore": number, // 0-10
  "signals": ["AFFECTION","FLIRT","VULNERABILITY","CONFLICT","PLANNING","CHECKIN","LOGISTICS","DRY","UNKNOWN"],
  "why": string, // one short sentence
  "recommendedBackfill": { "immediate": 0 | 100, "scheduled": 0 | 400 },
  "evidenceMessageId": string | null,
  "evidenceText": string | null
}

Rules:
- Use only the supplied messages; do NOT infer beyond the text. If unsure, pick LOW and keep score low.
- Be robust to sarcasm and pet names.
- Signals should only use the allowed enum values; include 1-4 that best justify the tier.
- Prefer providing evidenceMessageId and evidenceText (substring) when tier is MED or HIGH; if unclear, set them to null.
- If you provide evidenceMessageId, it MUST match exactly one of the provided message ids for that chat. evidenceText must be a substring of that message body.
- Map heatTier to backfill: LOW => {immediate:0, scheduled:0}, MED => {immediate:100, scheduled:0}, HIGH => {immediate:100, scheduled:400}.
- Output strict JSON: { "results": [ ...one object per chat in the SAME order provided... ] } and nothing else.

Chats (newest-last within each chat):
${chatSections}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

export function buildOrchestratorHeatPrompt(chats: OrchestratorHeatChatSlice[]): ChatCompletionRequest {
  const system = `You classify relationship intimacy / emotional heat from short chat snippets. Return JSON only.`.trim();

  const chatSections = chats
    .map((chat, idx) => {
      const msgs = chat.messages
        .map((m) => {
          const iso = new Date(m.ts).toISOString();
          return `- [${iso}] ${m.speaker} type=${m.type}: ${JSON.stringify(m.body)}`;
        })
        .join("\n");
      return `Chat ${idx + 1}: chatId=${chat.chatId}, displayName=${chat.chatDisplayName}\nMessages:\n${msgs}`;
    })
    .join("\n\n");

  const user = `
You will receive multiple 1:1 chats. ME is the user; OTHER is the counterpart. Null bodies are already replaced with media markers. Do NOT infer names or events that are not present.

Return JSON only in this exact shape:
{
  "results": [
    {
      "chatId": string,
      "heatTier": "LOW" | "MED" | "HIGH",
      "heatScore": number,  // 0-10
      "reasons": string[]   // up to 3, grounded in observable cues like night messages, affection terms, voice notes, rapid back-and-forth, revoked, etc.
    }
  ]
}

Guidelines:
- Keep responses deterministic and concise.
- No deep psychoanalysis. Only "should we prioritize deeper backfill" based on the snippet.
- If uncertain, lean toward LOW with low score.
- Reasons must reference observable cues from the messages; no hallucinated facts.

Chats:
${chatSections}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

export function buildSignalsDigestPrompt(opts: { windowHours: number; generatedAtTs: number; chats: SignalsChat[] }): ChatCompletionRequest {
  const { windowHours, generatedAtTs, chats } = opts;
  const system = `You are a cautious safety/relationship signals triager. Be conservative. Return JSON only.`.trim();
  const chatLines = chats
    .map((c, idx) => {
      const msgs = c.messages
        .map((m) => `- [${new Date(m.ts).toISOString()}] ${m.fromMe ? "ME" : "OTHER"} type=${m.type}: ${JSON.stringify(m.body ?? "")}`)
        .join("\n");
      return `Chat ${idx + 1}: chatId=${c.chatId}, messageCount=${c.messageCount}\nMessages:\n${msgs}`;
    })
    .join("\n\n");

  const user = `
You will triage chats for concerning or noteworthy relational signals within the last ${windowHours} hours.
If signal is weak/unclear, return an empty watchlist.

Return JSON exactly in this schema:
{
  "windowHours": number,
  "generatedAtTs": number,
  "watchlist": [
    {
      "chatId": string,
      "watchScore": number,          // 0-100, higher = more concern/attention
      "direction": "self" | "other" | "mutual",
      "tags": ["flirtation","sexual","secrecy","pressure","love_bombing","manipulation","conflict","avoidance","impulsivity"],
      "summary": string,             // 1-2 lines
      "evidence": string[],          // <=3 short excerpts
      "nextAction": string,          // short suggestion
      "confidence": number           // 0-1
    }
  ],
  "globalPatterns": {
    "notes": string[]               // <=5 bullets
  }
}

Chats:
${chatLines}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

export function buildSignalsEventsPrompt(opts: {
  windowHours: number;
  generatedAtTs: number;
  maxEvents: number;
  chats: SignalsChat[];
}): ChatCompletionRequest {
  const { windowHours, generatedAtTs, maxEvents, chats } = opts;
  const system = `You are a cautious relationship/safety signal triager. Return JSON only.`.trim();
  const chatLines = chats
    .map((c, idx) => {
      const msgs = c.messages
        .map((m) => `- [${new Date(m.ts).toISOString()}] ${m.fromMe ? "ME" : "OTHER"} type=${m.type}: ${JSON.stringify(m.body ?? "")}`)
        .join("\n");
      return `Chat ${idx + 1}: chatId=${c.chatId}, messageCount=${c.messageCount}\nMessages:\n${msgs}`;
    })
    .join("\n\n");

  const user = `
You will look for notable relational/safety signals in the last ${windowHours} hours.
Be conservative: if unsure, return empty events and zero counts.

Return JSON exactly:
{
  "windowHours": number,
  "generatedAtTs": number,
  "counts": {
    "sexual_flirt": number,
    "secrecy_concealment": number,
    "pressure_coercion": number,
    "triangulation_undermining": number,
    "meetup_plan": number,
    "money_transactional": number,
    "conflict_threat_abuse": number,
    "intimacy_confession": number
  },
  "events": [
    {
      "type": "sexual_flirt" | "secrecy_concealment" | "pressure_coercion" | "triangulation_undermining" | "meetup_plan" | "money_transactional" | "conflict_threat_abuse" | "intimacy_confession",
      "chatId": string,
      "ts": number,
      "direction": "incoming" | "outgoing" | "mutual",
      "evidence": string[],   // <=3 short excerpts
      "confidence": number    // 0-1
    }
  ]
}

Rules:
- Sort events by ts descending.
- Cap total events to maxEvents=${maxEvents}; keep most recent.
- If not enough signal, return empty events and zero counts.
- Base everything strictly on provided messages; no hallucinations.

Chats:
${chatLines}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}


export function buildSummaryPrompt(messages: SummaryRequestMessage[]) {
  const system = `
You are an assistant that analyses WhatsApp conversations and returns structured JSON.
Always respond in English only (translate source content as needed, keep names/proper nouns as-is).

Your job is to summarise messages, extract key people, key topics, and any "open loops"
(promises, follow-ups, questions, or time-sensitive items).

Always respond with a single JSON object that matches this TypeScript type:

{
  "narrativeSummary": string;
  "keyPeople": string[];
  "keyTopics": string[];
  "openLoops": {
    "messageId": string;
    "chatId": string;
    "who": string;
    "what": string;
    "when"?: string | null;
    "category": "promise" | "follow_up" | "question" | "time_sensitive";
  }[];
}

Important notes:
- Each message has a "fromMe" flag in the metadata. The caller will use this to determine
  who is "me" vs "them". You do NOT need to infer the speaker identity from pronouns.
- Focus openLoops on real-world tasks, promises, questions, or time-sensitive items.
- Avoid including vague emotional remarks or jokes as open loops.
`.trim();

  const user = `
Here is an array of messages in chronological order (oldest first).

Each message has:
- id: unique message id
- chatId: conversation id
- displayName: best-guess human name for the sender
- fromMe: whether I sent it
- ts: timestamp in milliseconds since epoch
- body: the text content

Messages:

${JSON.stringify(messages, null, 2)}

Now:

1. Write a short "narrativeSummary" (2–5 sentences) that describes what is going on overall.
2. Extract "keyPeople": array of human-readable names (displayName) involved.
3. Extract "keyTopics": 3–10 short phrases representing the main topics.
4. Extract "openLoops": only for real tasks, promises, questions, or time-sensitive items.

For openLoops:
- "messageId": the id of the source message
- "chatId": the chatId of the source message
- "who": a brief human-readable label such as "me", "them", "Ashley", "Mum", etc.
  (the caller may override this later based on metadata)
- "what": concise description of the action or question
- "when": null if not specified; otherwise a short phrase ("tomorrow evening", "2025-02-14", etc.)
- "category": "promise", "follow_up", "question", or "time_sensitive"

Only include an openLoop if ALL of these are true:
- There is a clear or strongly implied action or question.
- Someone is being asked to do something OR someone promises to do something.
- It is something a reasonable person might want to remember or track (task, favour, meeting, decision, follow-up).

DO NOT include:
- Pure feelings ("I miss you", "I'm tired", "I'm happy").
- Jokes or teasing with no follow-up.
- Observations ("I never saw that video before", "that's funny").
- Simple greetings without any action.

Return ONLY a JSON object, no markdown.
`.trim();

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

export function buildOpenLoopsPrompt(messages: SummaryRequestMessage[]) {
  const system = `
EA_POSTIT_OPEN_LOOPS_V1 — YOU ARE AN ELITE EXECUTIVE ASSISTANT

Model: GPT-4.1 Nano.
Your job is NOT to summarize chats. Your job is to prevent regret: missed replies, missed decisions, missed commitments, and missed logistics.
Be selective and conservative; silence is better than noise.

Respond ONLY with:
{
  "openLoops": {
    "messageId": string;
    "chatId": string;
    "who": string;
    "what": string;
    "when"?: string | null;
    "category": "promise" | "follow_up" | "question" | "time_sensitive";
    "status"?: "open" | "done";
    "urgency"?: "low" | "moderate" | "high";
    "importance"?: number; // 1-10
    "confidence"?: number; // 0-1
    "intentKey"?: string; // coarse stable intent (no dates; no personal names unless essential)
    "intentLabels"?: string[]; // optional tags
    "loopKey"?: string; // finer key if needed
  }[];
  "chatSummary"?: string;       // 1-2 line summary of this chat in this window
  "chatMood"?: "very_negative" | "mostly_negative" | "mixed" | "mostly_positive" | "very_positive";
  "chatThemes"?: string[];      // 3-6 concise themes/concerns for this chat in this window
  "chatTone"?: string[];        // 3-5 adjectives for the vibe in this chat window
  "keyMoments"?: { "messageId": string; "summary": string; "who": string; }[]; // 1-3 terse bullets
  "asksFromThem"?: number;      // count of actionable asks from them
  "asksFromMe"?: number;        // count of actionable asks from me
}
`.trim();

  const user = `
Here are recent messages:

${JSON.stringify(messages, null, 2)}

Rules (Post-It test):
1) Output at most 5 items. Fewer is better. Zero is valid.
2) Each item must pass: "If the user forgot this, would it cause social/emotional/professional/logistical harm?"
3) Consolidate duplicates/variants into ONE item per intent. Do NOT split “send link / instructions / test / feedback”.
4) Ignore banter, opinions, greetings, emotional reassurance without action, vague ideas, hypotheticals, or suggestions with no expectation.
5) Group chats: ignore unless the user is explicitly assigned or asked to do/decide something.
6) Promises: only keep if they imply a concrete future action. “I’ll always be here” is NOT a task.
7) Time: prefer near-term (today–few days). Long-term vague intentions are ignored unless time-sensitive.

Output rules:
- Cap 5 items. Consolidate by intent using intentKey (snake_case, no dates/names unless essential). Keep loopKey if helpful.
- "who": short label ("me", "them", or name).
- "when": null unless explicit timing; whenOptions can include timing variants.
- "category": promise | follow_up | question | time_sensitive.
- Set status done if clearly completed; else open.
- urgency: high/moderate/low; importance: 1–10; confidence: 0–1.
- Also return chatSummary/chatMood/chatThemes/chatTone/keyMoments/asksFromThem/asksFromMe.
- Example: messages say "send testing link", "black box", "instructions", "give feedback" → ONE loop with intentKey "pedrito_testing", summary "Help with Pedrito testing: send link + instructions, run black box, give feedback", timesMentioned aggregated.
- Do NOT include pure sentiment/well-wishes/apologies unless there is an explicit ask/commitment requiring user action.

Return ONLY the JSON object, no markdown.
`.trim();

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

export function buildEAOpenLoopsV1Prompt(input: {
  chatId: string;
  displayName: string | null;
  isGroup: boolean;
  priorOpenLoops: any[];
  messages: SummaryRequestMessage[];
  contextMessages?: SummaryRequestMessage[];
  newMessages?: SummaryRequestMessage[];
  existingOpenLoops?: any[];
  ownerPerspective?: "me";
}) {
  const system = `
EA_OPEN_LOOPS_V1 — YOU ARE AN ELITE EXECUTIVE ASSISTANT

Model: GPT-4.1 Nano.
Your job is to prevent regret: missed replies, missed decisions, missed commitments, missed logistics.
Be selective; silence is better than noise.

Return ONLY JSON:
{
  "openLoops": {
    "id"?: string;
    "taskGoal"?: string;
    "type": "reply_needed" | "decision_needed" | "todo" | "event_date" | "info_to_save";
    "summary": string;
    "actor": "me" | "them" | string;
    "when"?: string | null;
    "whenDate"?: string | null;
    "hasTime"?: boolean;
    "whenOptions"?: string[];
    "status": "open" | "done";
    "blocked"?: boolean;
    "confidence": number; // 0..1
    "importance": number; // 1..10
    "urgency": "low" | "moderate" | "high";
    "context"?: string;
    "evidenceMessageId": string; // must match one of the provided messages
    "evidenceText": string;      // verbatim substring of that message
  }[];
  "notes"?: string[];
}
`.trim();

  const msgLines = input.messages
    .map((m) => {
      const speaker = m.fromMe ? "me" : m.displayName || "them";
      const body = JSON.stringify(m.body ?? "").slice(1, -1);
      return `- [${new Date(m.ts).toISOString()}] ${speaker}: ${body}`;
    })
    .join("\n");

  const user = `
Chat metadata:
- chatId: ${input.chatId}
- displayName: ${input.displayName ?? "unknown"}
- isGroup: ${input.isGroup}
- ownerPerspective: ${input.ownerPerspective ?? "me"} (only capture obligations for this owner)

Prior open loops for this chat (latest state):
${JSON.stringify(input.priorOpenLoops ?? [], null, 2)}

Context messages (already processed, for continuity):
${JSON.stringify(input.contextMessages ?? [], null, 2)}

New messages (chronological; evidence must point here unless updating an existing loop id):
${JSON.stringify(input.newMessages ?? input.messages ?? [], null, 2)}

Rules:
- Output at most 10 items; fewer is better.
- A loop = one obligation owned by the user, not a conversational turn.
- Consolidate anything that belongs to the same task/goal (e.g., “link + instructions + feedback” = ONE item). Do not split clarifying questions.
- If the user’s action is waiting on the other party (e.g., they must send a link), mark blocked=true on that single loop instead of creating another loop.
- Only include EA-grade items:
  reply_needed (someone asked me something),
  decision_needed (I must choose/confirm),
  todo (I promised / was asked to do something),
  event_date (concrete date/time to schedule/remember),
  info_to_save ONLY if explicitly told to remember/note/save OR durable facts (address, allergy, flight #) with high confidence.
- Consolidate variants of the same task; do NOT split “link/instructions/feedback/testing”.
- Group chats: ignore chatter unless there is an explicit ask/request/plan requiring my response.
- Explicitly DO NOT create loops for greetings, small talk, “how was your day”, general sentiment (“hope you’re ok”), or “X is busy”.
- status="done" only if clearly completed in these messages.
- If unsure whether actionable, omit or include as low-confidence info_to_save (not todo).
- Must be grounded in messages; no hallucination.
- Preserve/merge priorOpenLoops: update when/whenOptions, reflect follow-ups, close only if clearly done, keep wording concise.
- Group candidate loops by (chatId + obligation owner + inferred task goal) before emitting; one loop per underlying intent.
- Prefer near-term items; drop long-term vague intentions unless time-sensitive.

Examples:
- “want tea sometime?” → one loop (reply/decision)
- “I like tea” → not a loop
- “How?” → not a loop; update context of the related task instead
- “send testing link + instructions + feedback” → ONE loop with blocked=true if waiting on the link
- “please test this and tell me” → ONE loop for owner: send what they need + follow up for feedback (blocked until feedback arrives)
- Every openLoop must include evidenceMessageId and evidenceText copied verbatim from that exact message. evidenceMessageId MUST be one of the provided messageIds (not a timestamp). evidenceText MUST be an exact substring (max ~20 words) from that message body. If you cannot pick an exact messageId, output zero loops and no evidence guesses. Evidence for new loops must point to the NEW messages provided above.

Return JSON only.
`.trim();

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

export function buildRelationshipPrompt(
  messages: SummaryRequestMessage[],
  chatId: string,
  displayName: string | null
) {
  const system = `
You are an assistant that analyses WhatsApp conversations to infer the nature and health of a relationship.
Treat messages with "fromMe": true as spoken by "me"; "fromMe": false as spoken by "them".
Use neutral third-person analytical language in all outputs (e.g., "the user", "the other party", "the partner"), never first-person ("I", "me", "my").
Always respond in English only (translate source content as needed, keep names/proper nouns as-is).

Always respond with a single JSON object that matches this TypeScript type exactly:
{
  "chatId": string;
  "displayName": string | null;
  "relationshipType": string;   // e.g. "romantic partner", "close friend", "family", "acquaintance"
  "closeness": "low" | "medium" | "high" | "very_high";

  "toneDescriptors": string[];  // 3–10 adjectives for the vibe (affectionate, supportive, playful, tense, etc.)
  "communicationStyle": string; // short text, e.g. "daily, lots of emojis, voice notes"
  "primaryLanguages": string[]; // e.g. ["English", "Spanish"], if detectable

  "keyTopics": string[];           // recurring themes in the chat
  "sharedGoalsOrPlans": string[];  // plans or projects discussed together
  "recurringConcerns": string[];   // fears, stressors, worries they share

  "thingsTheyCareAbout": string[];       // what seems important to *them*
  "preferences": string[];               // likes/dislikes, style, communication prefs
  "boundariesOrSensitivities": string[]; // things they are touchy/sensitive about

  "firstMessageTs": number | null;
  "lastMessageTs": number | null;

  "suggestedWaysToSupport": string[];      // 3–8 concrete, actionable ways to support them better
  "suggestedThingsToFollowUpOn": string[]; // relational/emotional things to revisit

  "notableMoments": {
    "ts": number;
    "role": "me" | "them";
    "summary": string;
  }[]; // 3–8 key moments from the conversation

  "overallSummary": string; // 3–6 sentence narrative describing the relationship

  "model"?: {
    "energeticPolarity": "balanced" | "me_chasing" | "them_chasing" | "unclear";
    "emotionalValence": {
      "overall": "mostly_positive" | "mixed" | "mostly_negative" | "unclear";
      "recentTrend": "improving" | "worsening" | "stable" | "unclear";
    };
    "intimacy": {
      "emotional": number;          // 0–100
      "vulnerability": number;      // 0–100
      "physicalOrSexual": number;   // 0–100
    };
    "attraction": {
      "myAttraction": number;       // 0–100
      "theirAttraction": number;    // 0–100
      "flirtationLevel": number;    // 0–100
    };
    "communicationDynamics": {
      "initiationPattern": "balanced" | "mostly_me" | "mostly_them" | "unclear";
      "consistency": "very_consistent" | "consistent" | "sporadic" | "on_off" | "unclear";
      "typicalResponseTime": "very_fast" | "fast" | "moderate" | "slow" | "very_slow" | "unclear";
      "timeOfDayPattern"?: string;
    };
    "powerBalance": {
      "perceivedBalance": "balanced" | "me_leading" | "them_leading" | "unclear";
      "emotionalDependency": "balanced" | "i_dependent" | "they_dependent" | "mutual_high" | "unclear";
    };
    "volatility": {
      "stabilityScore": number; // 0–100
      "conflictFrequency": "rare" | "sometimes" | "frequent" | "unclear";
      "emotionalSwings": "low" | "medium" | "high" | "unclear";
    };
    "behaviouralLoops": {
      "patterns": [
        // 1–5 conditional loops like "when X, the user/other party tends to Y"; avoid generic niceties or one-offs
        "when the other party is stressed, the user drops everything to fix it",
        "when the user feels lonely late at night, they start sending long messages"
      ];
    };
    "riskBehaviours": {
      "temptationScore": number;    // 0–100
      "selfSabotageScore": number;  // 0–100
      "boundarySlipScore": number;  // 0–100
      "notes"?: [
        // add at least one note if any score > 0; neutral behavioural description
        "the user sometimes sacrifices sleep to keep talking"
      ];
    };
    "valuesAlignment": {
      "alignmentScore": number;     // 0–100
      "growthImpact": "strong_positive" | "positive" | "neutral" | "negative" | "harmful" | "unclear";
      "comments"?: string[];
    };
    "trajectory": {
      "longTermTrajectory": "expanding" | "deepening" | "stable" | "drifting" | "deteriorating" | "cyclical" | "unclear";
      "recentKeyShifts"?: string[];
    };
    "shadowPatterns": [
      // 1–5 concise blind spots about the user; no blaming them; no mundane logistics
      "the user avoids hard conversations to keep the peace",
      "the user chases reassurance when feeling insecure"
    ];
  };
}

Guidance:
- You are describing the REAL relationship dynamic between two people based ONLY on their chat history. Your job is NOT to be nice. Be accurate, specific, and behaviourally honest.
- Do NOT sugarcoat. Be clear, specific, and neutral. Call out asymmetry, overfunctioning, confusion, mixed signals, or avoidant behaviour if present.
- If the user is over-pursuing, over-texting, love-bombing, or using heavy words quickly, say so. If the other person is inconsistent, dry, or less engaged, say so.
- Tone interpretation: only call something "shocked"/"upset"/"worried" if the words clearly show it. If the only signal is a playful/flirtatious emoji (like 😳 in a romantic context), treat it as playful surprise/teasing unless surrounding text shows real distress.
- recurringConcerns and shadowPatterns should include tensions, frustrations, or repeated emotional themes. Avoid exaggerated praise ("perfect", "ideal", "soulmate") unless those exact phrases appear repeatedly.
- In shadowPatterns, include at least 3 concrete patterns if possible: subtle self-sabotage, over-giving, under-communicating needs, conflict avoidance, repeating coping strategies (e.g., "the user sends long emotional messages late at night when anxious"; "the other person goes quiet after intense intimacy"; "both use humour/flirting to skip serious topics").
- In riskBehaviours, be specific about what could go wrong if behaviour continues; practical risk analysis, not moral judgement.
- "relationshipType": best-guess the relationship label based on language, frequency, affection, and content.
- "closeness": consider vulnerability, frequency, emotional openness, support, conflict resolution.
- "toneDescriptors": provide 3–10 adjectives capturing the dominant vibe.
- "notableMoments": select 3–8 moments; use message timestamps; set role based on fromMe vs them; summarize briefly.
- "model" is descriptive and non-judgemental. Do NOT moralise or diagnose. Use only the allowed enum values; keep numeric scores between 0–100; prefer "unclear" when evidence is thin. Keep notes/comments/shadowPatterns short and behavioural.
- behaviouralLoops.patterns: 1–5 items, each a conditional loop phrased like "when X, I/we tend to Y". Focus on repeated behaviours, not decorative habits. Avoid one-off events or generic niceties ("we use pet names", "hotel sharing during travel"). Examples: "when they are stressed, I drop everything to fix it"; "when I feel lonely late at night, I send long messages"; "after arguments, we both overcompensate with extra affection".
- shadowPatterns: 1–5 concise blind spots about the user. Do not blame the other person. No mundane logistics (battery issues, travel delays). Examples: "the user avoids hard conversations to keep the peace"; "the user over-promises support when feeling guilty"; "the user chases reassurance when feeling insecure"; "the user downplays their own needs when the other party is struggling".
- riskBehaviours.notes: if any risk score > 0, include at least one neutral behavioural note explaining why (e.g., "the user sometimes sacrifices sleep to keep talking", "the user occasionally neglects other responsibilities to support the partner"). Keep notes factual, non-dramatic, consequence-oriented.
- Be honest and specific. Prefer concrete behavioural loops over poetic language. Avoid shame or moral judgment; just describe what seems to be happening. Use neutral third-person phrasing ("the user", "the other party"). If you cannot infer something, return an empty array, null, or "unclear" as appropriate, but keep the JSON shape exact.
`.trim();

  const user = `
You will be given normalized WhatsApp messages for one chat. Use the metadata, not pronouns, to know who is "me" vs "them".

Chat metadata:
- chatId: ${chatId}
- displayName (if known): ${displayName ?? "null"}

Messages (oldest first):

${JSON.stringify(messages, null, 2)}

Now produce the RelationshipSummary JSON. Return ONLY the JSON object, no markdown or commentary.
`.trim();

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

export function buildIntelFactsPrompt(params: {
  chatId: string;
  messages: SummaryRequestMessage[];
  hours: number;
  isGroup: boolean;
  chatDisplayName?: string | null;
  mode?: "bootstrap" | "default";
}): ChatCompletionRequest {
  const { chatId, messages, hours, isGroup, chatDisplayName, mode } = params;
  const system = `
You are an evidence-grounded analyst. This is a WhatsApp transcript. ME is the user.
Extract only verifiable intel from one chat.
Rules:
- Return JSON only in the shape: {"facts":[{...}]}
- Each fact must include: type ("EVENT"|"EMOTION_CONCERN"|"RELATIONSHIP_DYNAMIC"), epistemicStatus ("event_claim"|"self_report"|"observed_pattern"|"hypothesis"), summary (short), entities (array), evidenceMessageId, evidenceText (verbatim substring of that message), attributedTo ("ME"|"OTHER"|"UNKNOWN"), signalScore (1-5).
- EVENT must be a real-world happening (met, argued, traveled, scheduled, health incident, decision, purchase). Questions/check-ins/status updates are NOT EVENT.
${mode === "bootstrap" ? "- Output ONLY RELATIONSHIP_DYNAMIC and EMOTION_CONCERN. Do not output EVENT." : ""}
- Include time fields only as:
  - timeCertainty: "explicit" | "implied" | "unknown"
  - timeMention: raw phrase if present (e.g., "last night", "tomorrow at 7")
  - when/whenDate ONLY when explicit or strongly implied; otherwise leave null. Never guess.
- Questions like "how are you/what's on your mind/what projects..." should be RELATIONSHIP_DYNAMIC or dropped if low signal.
- Micro-logistics or filler ("aww", toilet/loo/bathroom, random video call mentions) should be dropped unless clearly meaningful.
- If you cannot find evidence for a fact, do not emit it.
- Prefer fewer, higher-quality facts. Ignore greetings and small talk.
- Ground everything in the provided messages only.
`.trim();

  const msgLines = messages
    .map(
      (m) =>
        `[${new Date(m.ts).toISOString()}] id=${m.id} ${m.fromMe ? "ME" : m.displayName ?? m.chatId}: ${m.body ?? ""}`
    )
    .join("\n");

  const user = `
Metadata:
- chatId: ${chatId}
- chatDisplayName: ${chatDisplayName ?? "unknown"}
- isGroup: ${isGroup}
${isGroup ? "- group chat; only mark attributedTo=ME if fromMe=true" : `- 1:1: participants are ME and ${chatDisplayName ?? "them"}`}

Chat: ${chatId}
Window: last ${hours} hours
Messages:
${msgLines}

Return JSON only:
{"facts":[{"type":"EVENT","epistemicStatus":"event_claim","attributedTo":"ME","signalScore":4,"summary":"...","entities":["..."],"timeCertainty":"explicit","timeMention":"tomorrow at 7pm","when":"YYYY-MM-DDTHH:MM:SSZ","whenDate":"YYYY-MM-DD","evidenceMessageId":"...","evidenceText":"..."}]}
`.trim();

  return {
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  };
}

// Re-export types if you were using them from here previously
export type {
  ConversationSummary,
  OpenLoopItem,
  SummaryRequestMessage,
  RelationshipSummary,
};
