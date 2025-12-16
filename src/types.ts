export interface MessageRecord {
  id: string;
  chatId: string;
  senderId: string;      // 'me' or contact id
  displayName: string;
  fromMe: boolean;
  type: string;
  body: string | null;
  ts: number;
}

export interface SummaryRequestMessage {
  id: string;
  chatId: string;
  senderId: string;
  displayName: string;
  fromMe: boolean;
  ts: number;
  body: string;
}

export interface OpenLoopItem {
  messageId: string;
  chatId: string;
  who: string;          // "me" or "other" or name
  what: string;         // description of the action/question
  when?: string | null; // natural language or ISO date if inferred
  category: "promise" | "follow_up" | "question" | "time_sensitive";
}

export interface ConversationSummary {
  narrativeSummary: string;
  keyPeople: string[];
  keyTopics: string[];
  openLoops: OpenLoopItem[];
}

export interface RelationshipModel {
  energeticPolarity: "balanced" | "me_chasing" | "them_chasing" | "unclear";

  emotionalValence: {
    overall: "mostly_positive" | "mixed" | "mostly_negative" | "unclear";
    recentTrend: "improving" | "worsening" | "stable" | "unclear";
  };

  intimacy: {
    emotional: number; // 0–100
    vulnerability: number; // 0–100
    physicalOrSexual: number; // 0–100
  };

  attraction: {
    myAttraction: number; // 0–100
    theirAttraction: number; // 0–100
    flirtationLevel: number; // 0–100
  };

  communicationDynamics: {
    initiationPattern: "balanced" | "mostly_me" | "mostly_them" | "unclear";
    consistency: "very_consistent" | "consistent" | "sporadic" | "on_off" | "unclear";
    typicalResponseTime: "very_fast" | "fast" | "moderate" | "slow" | "very_slow" | "unclear";
    timeOfDayPattern?: string;
  };

  powerBalance: {
    perceivedBalance: "balanced" | "me_leading" | "them_leading" | "unclear";
    emotionalDependency: "balanced" | "i_dependent" | "they_dependent" | "mutual_high" | "unclear";
  };

  volatility: {
    stabilityScore: number; // 0–100
    conflictFrequency: "rare" | "sometimes" | "frequent" | "unclear";
    emotionalSwings: "low" | "medium" | "high" | "unclear";
  };

  behaviouralLoops: {
    patterns: string[];
  };

  riskBehaviours: {
    temptationScore: number; // 0–100
    selfSabotageScore: number; // 0–100
    boundarySlipScore: number; // 0–100
    notes?: string[];
  };

  valuesAlignment: {
    alignmentScore: number; // 0–100
    growthImpact: "strong_positive" | "positive" | "neutral" | "negative" | "harmful" | "unclear";
    comments?: string[];
  };

  trajectory: {
    longTermTrajectory:
      | "expanding"
      | "deepening"
      | "stable"
      | "drifting"
      | "deteriorating"
      | "cyclical"
      | "unclear";
    recentKeyShifts?: string[];
  };

  shadowPatterns: string[];
}

export interface RelationshipSummary {
  chatId: string;
  displayName: string | null;
  relationshipType: string;   // e.g. "romantic partner", "close friend", "family", "acquaintance"
  closeness: "low" | "medium" | "high" | "very_high";

  toneDescriptors: string[];  // e.g. ["affectionate", "supportive", "playful"]
  communicationStyle: string; // short text, e.g. "daily, lots of emojis, voice notes"
  primaryLanguages: string[]; // e.g. ["English", "Spanish"], if detectable

  keyTopics: string[];           // recurring themes in the chat
  sharedGoalsOrPlans: string[];  // plans or projects discussed together
  recurringConcerns: string[];   // fears, stressors, worries they share

  thingsTheyCareAbout: string[];       // what seems important to *them*
  preferences: string[];               // likes/dislikes, style, communication prefs
  boundariesOrSensitivities: string[]; // things they are touchy/sensitive about

  firstMessageTs: number | null;
  lastMessageTs: number | null;

  metrics?: RelationshipMetrics;
  model?: RelationshipModel;

  suggestedWaysToSupport: string[];      // how the user can show up better for them
  suggestedThingsToFollowUpOn: string[]; // relational/emotional things to revisit

  notableMoments: {
    ts: number;
    role: "me" | "them";
    summary: string;
  }[];

  overallSummary: string; // 3–6 sentence narrative describing the relationship
}

export interface RelationshipSnapshot {
  chatId: string;
  snapshotTs: number; // ms since epoch when snapshot was taken
  window?: {
    fromTs: number | null;
    toTs: number | null;
  };
  summary?: {
    overallSummary?: string;
    keyTopics?: string[];
  };
  metrics: RelationshipMetrics;
  model: RelationshipModel;
  lastMessageTs?: number | null;
  messageCount?: number;
  modelUsed?: string;
}

export interface WindowContactSlice {
  chatId: string;
  displayName: string;
  // volume & direction
  messagesFromMe: number;
  messagesFromThem: number;
  // quick qualitative read
  toneDescriptors: string[]; // e.g. ["affectionate", "anxious"]
  relationshipRole?: string; // "romantic", "friend", "family", "work", etc.
  importanceScore?: number; // 1–10, how central they are in this window
  relationshipTrajectoryHint?: "deepening" | "cooling" | "unstable" | "steady" | "unknown";
  // very short window summary
  windowSummary?: string;
}

export interface WindowOpenLoop {
  // High-level, LLM-normalized open loop — **not** raw message-based
  id?: string; // optional; store can assign UUID
  chatId: string;
  actor: string; // "me", "them", or a display name
  displayName?: string; // human-friendly contact name if known
  isGroup?: boolean;
  type: "invitation" | "promise" | "question" | "reminder" | "emotional_follow_up" | "time_sensitive" | "other";
  loopKey?: string; // stable intent key for deduping
  intentKey?: string; // coarse intent bucket
  intentLabels?: string[]; // optional tags
  summary: string; // short human-friendly description
  when?: string | null; // natural language time like "Saturday", "February", "tomorrow night"
  whenOptions?: string[]; // all time variants mentioned
  urgency: "low" | "moderate" | "high";
  importance: number; // 1–10
  confidence: number; // 0–1
  firstSeenTs: number;
  lastSeenTs: number;
  timesMentioned: number;
  status: "open" | "done" | "dismissed";
  needsUserAction?: boolean;
  canonicalIntentKey?: string;
}

export interface WindowEvent {
  ts: number;
  chatId: string;
  displayName: string;
  category: "social" | "romantic" | "family" | "work" | "health" | "money" | "faith" | "other";
  summary: string; // "Dinner with X", "Told Y about losing money", etc.
  impact: "low" | "medium" | "high";
}

export interface RelationshipMention {
  about: {
    name: string;
    chatId?: string | null;
  };
  sourceChatId: string;
  sourceDisplayName: string;
  ts: number;
  howTheySpoke: string; // "excited", "resentful", "conflicted", etc.
  summary: string; // "User told Billy they're less excited about talking to Ashley."
  implication?: string; // "possible cooling", "boundary crossing", etc.
  confidence: number; // 0–1
}

export interface WindowAnalysis {
  id: string;
  fromTs: number;
  toTs: number;
  generatedAt: number;
  modelUsed?: string;
  // mood/state-ish
  mood: "very_negative" | "mostly_negative" | "mixed" | "mostly_positive" | "very_positive";
  energyLevel: number; // 0–100
  stressLevel: number; // 0–100
  dominantConcerns: string[];
  selfTalkTone: string[]; // ["playful", "defensive", ...]
  underlyingThemes?: string[];

  // per-contact slices for this window
  contacts: WindowContactSlice[];

  // open loops generated or reinforced in this window
  openLoops: WindowOpenLoop[];

  // events in this window
  events: WindowEvent[];

  // cross-chat relationship mentions
  relationshipMentions: RelationshipMention[];

  // one-sentence summary for this window
  windowSummary: string;
}

export interface RelationshipRollup {
  chatId: string;
  displayName: string;
  baseSnapshot?: RelationshipSummary;
  rolling: {
    fromTs: number;
    toTs: number;
    recentEvents: WindowEvent[];
    recentMentions: RelationshipMention[];
    recentTrajectoryHint: "deepening" | "cooling" | "unstable" | "steady" | "unknown";
  };
  // optional: a compact "current view" model
  model?: RelationshipModel;
}

export interface UserCommunicationStyle {
  overallTone: string[];
  typicalLength: "short" | "mixed" | "long";
  emojiUsage: "low" | "medium" | "high";
  languages: string[];
}

export interface UserEmotionalPatterns {
  baselineMood: "mostly_positive" | "mixed" | "mostly_negative" | "unknown";
  reactivity: "low" | "medium" | "high";
  lateNightPatterns: string[];
  stressTriggers: string[];
}

export interface UserRelationalPatterns {
  attachmentVibe: string;
  whoTheyLeanOn: string[];
  conflictStyle: string;
  consistency: string;
}

export interface UserCopingAndHabits {
  copingStrategies: string[];
  selfSoothing: string[];
  selfSabotagePatterns: string[];
}

export interface UserValuesAndMotivation {
  explicitValues: string[];
  implicitValues: string[];
  currentBigThemes: string[];
}

export interface UserRiskEdges {
  burnoutRisk: "low" | "medium" | "high";
  heartRisk: "low" | "medium" | "high";
  patternsToWatch: string[];
}

export interface UserStrengths {
  relational: string[];
  personal: string[];
}

export interface UserProfile {
  id: "user-profile";
  communicationStyle: UserCommunicationStyle;
  emotionalPatterns: UserEmotionalPatterns;
  relationalPatterns: UserRelationalPatterns;
  copingAndHabits: UserCopingAndHabits;
  valuesAndMotivation: UserValuesAndMotivation;
  riskEdges: UserRiskEdges;
  strengths: UserStrengths;
  meta: {
    generatedAt: number;
    modelUsed: string;
    windowsCoveredHours?: number;
    relationshipsCovered?: number;
    stateDaysCovered?: number;
  };
  relationalFacets?: {
    primaryPartner?: RelationalFacetContact | null;
    romanticInterests?: RelationalFacetContact[];
    sexualPartners?: RelationalFacetContact[];
    closeFriends?: RelationalFacetContact[];
  };
}

export interface RelationalFacetContact {
  chatId: string;
  displayName: string;
  kind: ("primary_partner" | "romantic_interest" | "sexual_partner" | "close_friend" | "family" | "other")[];
  petName?: string | null;
}

export interface DailyStateSnapshot {
  date: string; // 'YYYY-MM-DD' in user's local timezone
  fromTs: number;
  toTs: number;
  mood: "mostly_positive" | "mixed" | "mostly_negative" | "flat" | "unknown";
  energyLevel: number; // 0-100
  stressLevel: number; // 0-100
  dominantConcerns: string[];
  selfTalkTone: string[];
  copingPatterns: string[];
  underlyingThemes?: string[];
  notableMoments: {
    ts: number;
    summary: string; // 3rd-person, neutral
  }[];
  topContacts?: DailyContactStats[];
  lateNightContacts?: DailyContactStats[];
  earlyMorningContacts?: DailyContactStats[];
  lateNightPrimaryContact?: DailyContactStats;
  earlyMorningPrimaryContact?: DailyContactStats;
  primaryActors?: DailyPrimaryActor[];
  drivers?: DailyDriver[];
}

export interface DailyContactStats {
  chatId: string;
  displayName: string;
  messageCount: number;
  fromMeCount: number;
  fromThemCount: number;
}

export interface DailyPrimaryActor {
  chatId: string;
  displayName: string;
  role?: "partner" | "friend" | "family" | "work" | "church" | "other";
  weight?: number;
}

export interface DailyDriver {
  type: "positive" | "negative" | "mixed";
  summary: string;
  relatedChatIds?: string[];
}

export interface DailyDigestSnapshot {
  date: string; // YYYY-MM-DD
  summary: ConversationSummary;
  openLoops: OpenLoopRecord[];
  generatedAt: number;
  meta: {
    fromTs: number | null;
    toTs: number | null;
    messageCount: number;
  };
}

export interface RelationshipMetrics {
  totalMessages: number;
  fromMeCount: number;
  fromThemCount: number;

  last7DaysCount: number;
  last30DaysCount: number;
  avgMessagesPerDay30d: number;
  daysSinceLastMessage: number | null;

  avgResponseTimeMsMe?: number;
  avgResponseTimeMsThem?: number;

  activityByTimeOfDay: {
    morning: number;   // 05:00–11:59
    afternoon: number; // 12:00–17:59
    evening: number;   // 18:00–22:59
    night: number;     // 23:00–04:59
  };

  mediaStats: {
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
    stickerCount: number;
  };
}

export interface IntelMeta {
  messageCount: number;
  fromTs: number | null;
  toTs: number | null;
}

export type OpenLoopStatus = "open" | "done" | "dismissed";
export type OpenLoopDirection = "me" | "them" | "broadcast";

export interface OpenLoopRecord {
  id: string;              // internal UUID
  sourceMessageId: string; // original WhatsApp message id
  chatId: string;
  who: string;             // "me" or displayName
  what: string;
  when: string | null;
  category: "promise" | "follow_up" | "question" | "time_sensitive";
  status: OpenLoopStatus;
  direction: OpenLoopDirection; 
  timesMentioned: number;
  firstSeenTs: number;     // ms since epoch
  lastSeenTs: number;      // ms since epoch
}
