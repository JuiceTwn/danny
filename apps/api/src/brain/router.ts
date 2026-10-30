import type { BudgetLevel } from "../lib/spend.js";
import type { Msg } from "./model.js";

/**
 * Which Claude model answers a request. Plain rules, no model call: the router has to be free and predictable.
 *
 *   Haiku   quick chat, reminders, simple lookups
 *   Sonnet  anything that needs quality: client posts, emails, planning, multi-step or tool work, attachments. Also the default when unsure.
 *   Opus    only when the user asks for it by name, or after Sonnet has failed twice
 *
 * Order of decisions: explicit Opus request, then the feature, then (for free-text chat) the message itself,
 * then the Haiku prompt-size limit, then "answer better", then the user's budget. Every decision carries a reason so it can be logged.
 */

export const TIERS = ["haiku", "sonnet", "opus"] as const;
export type Tier = (typeof TIERS)[number];

/** What the request is for. "chat" is free text, where the router has to guess from the message. */
export const FEATURES = ["chat", "quick_chat", "reminder", "lookup", "client_post", "email", "planning", "multi_step", "long_attachment"] as const;
export type Feature = (typeof FEATURES)[number];

const FEATURE_TIER: Record<Exclude<Feature, "chat">, Tier> = {
  quick_chat: "haiku",
  reminder: "haiku",
  lookup: "haiku",
  client_post: "sonnet",
  email: "sonnet",
  planning: "sonnet",
  multi_step: "sonnet",
  long_attachment: "sonnet",
};

const rank = (t: Tier) => TIERS.indexOf(t);
export const nextTier = (t: Tier): Tier | null => TIERS[rank(t) + 1] ?? null;
export const lowerTier = (t: Tier): Tier => TIERS[Math.max(0, rank(t) - 1)]!;

// ---- Prompt size ----

/** Haiku costs more once a single prompt passes 100K tokens. */
export const HAIKU_PROMPT_LIMIT_TOKENS = 100_000;
/** Token counts here are estimates (no extra API call), so Haiku is kept well under its limit. */
export const HAIKU_SAFE_TOKENS = 85_000;
/** Deliberately high: 3 characters a token overcounts ordinary English, which errs toward Sonnet. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 3);

/** Drops the oldest history until the whole prompt fits under `limitTokens`. Always keeps the newest messages and a clean start. */
export function fitHistory(history: Msg[], fixedChars: number, limitTokens = HAIKU_SAFE_TOKENS, startsCleanly: (rows: Msg[]) => Msg[] = (r) => r): Msg[] {
  let rows = history;
  const size = (r: Msg[]) => estimateTokens(fixedChars + JSON.stringify(r).length);
  while (rows.length > 1 && size(rows) > limitTokens) rows = startsCleanly(rows.slice(1));
  return rows;
}

// ---- Free-text rules ----

export const SHORT_MESSAGE_CHARS = 280;
export const LONG_MESSAGE_CHARS = 600;
export const LONG_ATTACHMENT_CHARS = 4_000;
const LOOKUP_MAX_CHARS = 240;
const REMINDER_MAX_CHARS = 500;

const REMINDER = /^\s*(please\s+)?(remind me|set (a |another )?reminder|reminder:)/i;
/** Naming a model explicitly. Narrow on purpose, so a message that merely mentions the word doesn't spend Opus money. */
const ASKS_FOR_OPUS = /(^\s*opus\s*[:,-])|\b(use|using|with|ask|try|switch to|go to|give me|want|need)\s+(claude\s+)?opus\b/i;

// Quality work. Each group also names the feature the request is logged as.
const KEYWORDS: { feature: Feature; words: RegExp }[] = [
  { feature: "email", words: /\b(e-?mails?|subject line|cold (email|outreach)|follow[- ]?up (email|message))\b/i },
  { feature: "client_post", words: /\b(posts?|captions?|listing|gbp|google business|google profile|announcement|newsletter|blog)\b/i },
  { feature: "planning", words: /\b(plan|planning|strategy|outline|roadmap|campaign|prioriti[sz]e|(my|new|a|the) goal|goal is)\b/i },
  { feature: "chat", words: /\b(draft|write|rewrite|reply|respond|proposal|quote|invoice|pitch|review|analy[sz]e|compare|summari[sz]e|explain why|recommend)\b/i },
];
/** Work that changes something or sends it somewhere: Danny's tools that leave the app, or that edit a plan. */
const NEEDS_TOOLS = /\b(send|publish|book|approve|follow up|reach out|add (a |another )?(step|goal)|set (a |another )?goal|track|schedule)\b/i;
const MULTI_STEP = /(\bstep[- ]by[- ]step\b|\b(then|after that|afterwards|and also|next,)\b|^\s*\d+[.)]\s)/im;
const LOOKUP = /\b(what|when|where|who|which|how (much|many|long|old)|show|list|find|do i have|did i)\b/i;

export type RouteInput = {
  feature: Feature;
  message: string;
  attachmentCount?: number;
  attachmentChars?: number;
  /** Estimated tokens in the whole prompt: system, history, tools and this message. */
  promptTokens: number;
  /** The user picked Opus (an explicit option in a client), as opposed to saying so in the message. */
  askedForOpus?: boolean;
  /** "Answer better": the answer must come from at least this tier. */
  atLeast?: Tier;
  level: BudgetLevel;
};

export type Route = {
  tier: Tier;
  /** The tier the rules picked before the budget pushed it down. */
  wanted: Tier;
  feature: Feature;
  reason: string;
  downshifted: boolean;
  /** Haiku was forced by the budget and the prompt is over its limit: the caller must trim history to fit. */
  trimToFit: boolean;
  /** Whether Opus is on the table if Sonnet fails twice. Not when the user is near a cap. */
  canEscalate: boolean;
};

type Choice = { tier: Tier; feature: Feature; reason: string };

/** The rules for one free-text message. Anything not clearly simple goes to Sonnet. */
export function routeChat(i: Pick<RouteInput, "message" | "attachmentCount" | "attachmentChars">): Choice {
  const m = i.message.trim();
  const len = m.length;
  const sonnet = (feature: Feature, reason: string): Choice => ({ tier: "sonnet", feature, reason });

  if ((i.attachmentCount ?? 0) > 0) {
    return (i.attachmentChars ?? 0) >= LONG_ATTACHMENT_CHARS ? sonnet("long_attachment", "attachment:long") : sonnet("chat", "attachment");
  }
  if (REMINDER.test(m) && len <= REMINDER_MAX_CHARS) return { tier: "haiku", feature: "reminder", reason: "reminder" };
  for (const k of KEYWORDS) {
    const hit = k.words.exec(m);
    if (hit) return sonnet(k.feature, `keyword:${hit[0].toLowerCase()}`);
  }
  const tool = NEEDS_TOOLS.exec(m);
  if (tool) return sonnet("multi_step", `tools:${tool[0].toLowerCase()}`);
  if (MULTI_STEP.test(m) || m.split("\n").filter((l) => l.trim()).length >= 3) return sonnet("multi_step", "multi_step");
  if (len > LONG_MESSAGE_CHARS) return sonnet("chat", "long_message");
  if (len <= LOOKUP_MAX_CHARS && LOOKUP.test(m)) return { tier: "haiku", feature: "lookup", reason: "lookup" };
  if (len <= SHORT_MESSAGE_CHARS) return { tier: "haiku", feature: "quick_chat", reason: "short_simple" };
  return sonnet("chat", "unsure");
}

export function route(i: RouteInput): Route {
  let pick: Choice;
  if (i.askedForOpus || ASKS_FOR_OPUS.test(i.message)) {
    pick = { tier: "opus", feature: i.feature, reason: "user_asked_opus" };
  } else if (i.feature !== "chat") {
    pick = { tier: FEATURE_TIER[i.feature], feature: i.feature, reason: `feature:${i.feature}` };
  } else {
    pick = routeChat(i);
  }

  if (pick.tier === "haiku" && i.promptTokens > HAIKU_SAFE_TOKENS) {
    pick = { ...pick, tier: "sonnet", reason: "prompt_over_haiku_limit" };
  }
  if (i.atLeast && rank(pick.tier) < rank(i.atLeast)) {
    pick = { ...pick, tier: i.atLeast, reason: "answer_better" };
  }

  // The budget has the last word, and it moves requests down a tier instead of refusing them.
  const wanted = pick.tier;
  const tier: Tier = i.level === "critical" ? "haiku" : i.level === "near" ? lowerTier(wanted) : wanted;
  return {
    tier,
    wanted,
    feature: pick.feature,
    reason: pick.reason,
    downshifted: tier !== wanted,
    trimToFit: tier === "haiku" && i.promptTokens > HAIKU_SAFE_TOKENS,
    canEscalate: i.level === "ok",
  };
}
