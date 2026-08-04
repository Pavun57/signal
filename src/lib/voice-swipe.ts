/**
 * Voice capture by swiping, rather than by interview.
 *
 * The interview this replaced asked questions and offered A/B pairs whose
 * only permitted answers were "Prefers option A/B" or "no strong feeling".
 * That format couldn't express "the opener is right but the close is wrong",
 * and a pick between two of the agent's own drafts says little about how the
 * user would have written it themselves.
 *
 * This module holds the pure logic for the replacement: judge a stream of
 * varied drafts, and derive the rules from what actually gets kept.
 *
 * Everything here is deliberately free of React and of any network call, so
 * the convergence maths can be tested directly.
 */

export type OpenerStyle =
  | "signal"
  | "problem"
  | "data"
  | "story"
  | "question"
  | "social"
  | "compliment"
  | "pitch";

export type ToneStyle = "blunt" | "warm" | "neutral" | "formal";
export type CloseStyle = "question" | "cta" | "statement";
export type GreetingStyle = "firstname" | "hi" | "dear";
export type SignoffStyle = "name" | "none" | "best" | "regards";

/**
 * The axes a draft can differ on. The variation *is* the mechanism: a deck
 * that differs only in wording teaches nothing, because every swipe would mean
 * the same thing.
 */
export interface EmailAttrs {
  opener: OpenerStyle;
  tone: ToneStyle;
  close: CloseStyle;
  greeting: GreetingStyle;
  signoff: SignoffStyle;
}

export interface SwipeEmail {
  id: string;
  subject: string;
  body: string;
  words: number;
  attrs: EmailAttrs;
}

export interface Verdict {
  id: string;
  liked: boolean;
}

export type AttrKey = keyof EmailAttrs;

export const ATTR_KEYS: AttrKey[] = [
  "opener",
  "tone",
  "close",
  "greeting",
  "signoff",
];

// ── Convergence settings ────────────────────────────────────────────────────
//
// The run ends on an acceptance rate, not a fixed count: the point is to stop
// once the agent is reliably writing emails the user would send, and that takes
// six or sixteen drafts depending on how quickly the voice resolves.

/** Share of a rolling window that must be kept before the run ends. */
export const TARGET_RATE = 0.8;
/**
 * Rolling, never cumulative. A cumulative rate is dragged down permanently by
 * the deliberately-weak early drafts and would never clear the bar however
 * good the recent ones became.
 */
export const WINDOW = 5;
/** Floor, so a lucky opening run can't end it before anything is learned. */
export const MIN_JUDGED = 8;
export const FIRST_BATCH = 6;
export const REFILL = 4;

/** A straight run of rejections means the drafts are missing by a mile. */
export const STALL_STREAK = 5;
/** A long run that never converges means they're close but never right. */
export const STALL_TURNS = 15;
/** Hard ceiling. Past this the rules are written from whatever exists. */
export const MAX_JUDGED = 30;

// ── Text helpers ────────────────────────────────────────────────────────────

export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * 200 wpm, rounded to 5s. The slow end of the 200-260 range for prose is right
 * here because a cold email is scanned by someone deciding whether to bother,
 * not read by someone who already wants it. Rounding avoids implying a
 * precision a word count can't support.
 */
export function readSeconds(words: number): number {
  return Math.max(5, Math.round((words * 0.3) / 5) * 5);
}

// ── Rule vocabulary ─────────────────────────────────────────────────────────

const RULE_FOR: Record<AttrKey, Record<string, string>> = {
  opener: {
    signal: "Open on the signal itself: what they just shipped or announced.",
    problem: "Open on the problem, not the product.",
    data: "Open with a number, not a claim.",
    story: "Open with a short anecdote from another team.",
    question: "Open with a direct question.",
    social: "Open with what comparable teams did.",
    compliment: "Open with a compliment about their work.",
    pitch: "Open by introducing the product.",
  },
  tone: {
    blunt: "Stay blunt. No softening, no hedges.",
    warm: "Keep it warm and conversational.",
    neutral: "Keep the register plain and matter-of-fact.",
    formal: "Keep the register formal.",
  },
  close: {
    question: "Close on a bare question.",
    cta: "Close with an explicit ask for a call.",
    statement: "Close on a statement, not a question.",
  },
  greeting: {
    firstname: "Greet with the first name alone. No “Hi”.",
    hi: "Greet with “Hi” and the first name.",
    dear: "Greet with “Dear”.",
  },
  signoff: {
    name: "Sign off with your first name alone.",
    none: "Don't sign off at all.",
    best: "Sign off with “Best,” and your name.",
    regards: "Sign off with “Kind regards”.",
  },
};

const NEVER_FOR: Record<AttrKey, Record<string, string>> = {
  opener: {
    compliment: "Never open on a compliment.",
    pitch: "Never open by introducing the product.",
    social: "Don't lead with what other companies did.",
    story: "Don't open with an anecdote.",
    data: "Don't open with a statistic.",
    question: "Don't open with a question.",
    problem: "Don't open on a generic problem statement.",
    signal: "Don't open on their announcement.",
  },
  tone: {
    formal: "Never write formally.",
    warm: "Skip the pleasantries.",
    blunt: "Don't be too blunt.",
    neutral: "Don't be flat.",
  },
  close: {
    cta: "Never ask for a call outright.",
    question: "Don't close on a question.",
    statement: "Don't close on a statement.",
  },
  greeting: {
    hi: "Never write “Hi” before the name.",
    dear: "Never write “Dear”.",
    firstname: "Don't drop the greeting.",
  },
  signoff: {
    best: "Never sign off with “Best,”.",
    regards: "Never sign off with “Kind regards”.",
    name: "Don't sign off with just your name.",
    none: "Always sign off.",
  },
};

/** Plain-English fragments so the agent's running commentary reads as speech. */
export const PHRASE: Record<AttrKey, Record<string, string>> = {
  opener: {
    signal: "on the signal itself",
    problem: "on the problem",
    data: "with a number",
    story: "with an anecdote",
    question: "with a question",
    social: "with what other teams did",
    compliment: "with a compliment",
    pitch: "by introducing the product",
  },
  tone: { blunt: "blunt", warm: "warm", neutral: "plain", formal: "formal" },
  close: {
    question: "on a bare question",
    cta: "with an ask for a call",
    statement: "on a statement",
  },
  greeting: {
    firstname: "with the first name alone",
    hi: "with “Hi”",
    dear: "with “Dear”",
  },
  signoff: {
    name: "with your name alone",
    none: "with no sign-off",
    best: "with “Best,”",
    regards: "with “Kind regards”",
  },
};

/** The verb that makes a remark about this axis read naturally. */
export function verbFor(dim: AttrKey): string {
  if (dim === "opener") return "open ";
  if (dim === "close") return "close ";
  if (dim === "greeting") return "greet ";
  if (dim === "signoff") return "sign off ";
  return "read ";
}

// ── Derivation ──────────────────────────────────────────────────────────────

export interface Dominant {
  value: string;
  share: number;
  n: number;
}

/** Mode of one attribute across a pile, with the share it represents. */
export function dominant(pile: SwipeEmail[], dim: AttrKey): Dominant | null {
  const tally: Record<string, number> = {};
  let best: string | null = null;
  for (const e of pile) {
    const v = e.attrs[dim];
    tally[v] = (tally[v] ?? 0) + 1;
    if (best === null || tally[v] > tally[best]) best = v;
  }
  return best === null
    ? null
    : { value: best, share: tally[best] / pile.length, n: tally[best] };
}

/**
 * Rules come from the swipes themselves, so the same deck yields a different
 * voice for a different user. Nothing here is scripted.
 */
export function deriveRules(
  kept: SwipeEmail[],
  passed: SwipeEmail[],
): string[] {
  if (kept.length < 2) return [];
  const out: string[] = [];

  for (const dim of ATTR_KEYS) {
    const k = dominant(kept, dim);
    if (k && k.share >= 0.5 && k.n >= 2 && RULE_FOR[dim][k.value]) {
      out.push(RULE_FOR[dim][k.value]);
    }
  }

  for (const dim of ATTR_KEYS) {
    if (!passed.length) continue;
    // No share gate here: `opener` has eight possible values, so a
    // twice-rejected one never reaches a meaningful share even when it is
    // exactly the rule worth writing. Never-kept is what does the filtering.
    const p = dominant(passed, dim);
    if (!p || p.n < 2) continue;
    const alsoKept = kept.some((e) => e.attrs[dim] === p.value);
    if (!alsoKept && NEVER_FOR[dim][p.value]) out.push(NEVER_FOR[dim][p.value]);
  }

  const avg = Math.round(kept.reduce((s, e) => s + e.words, 0) / kept.length);
  out.push(`Keep the body around ${Math.ceil(avg / 10) * 10} words or under.`);
  return out;
}

export interface Rolling {
  kept: number;
  of: number;
  rate: number;
}

export function rolling(verdicts: Verdict[]): Rolling {
  const recent = verdicts.slice(-WINDOW);
  const k = recent.filter((v) => v.liked).length;
  return {
    kept: k,
    of: recent.length,
    rate: recent.length ? k / recent.length : 0,
  };
}

/** How many of a full window are needed — 4 of 5 at 80%. */
export function needed(): number {
  return Math.ceil(TARGET_RATE * WINDOW);
}

export function converged(verdicts: Verdict[]): boolean {
  const r = rolling(verdicts);
  return (
    verdicts.length >= MIN_JUDGED && r.of >= WINDOW && r.rate >= TARGET_RATE
  );
}

/** Trailing run of consecutive rejections. */
export function streak(verdicts: Verdict[]): number {
  let n = 0;
  for (let i = verdicts.length - 1; i >= 0; i--) {
    if (verdicts[i].liked) break;
    n += 1;
  }
  return n;
}

/**
 * Orders the next batch by how well it matches what has been kept. Stands in
 * for regeneration while the deck is static: acceptance climbs the way it would
 * if a model were writing to the learned rules.
 */
export function fitScore(email: SwipeEmail, kept: SwipeEmail[]): number {
  if (kept.length < 2) return 0;
  let s = 0;
  for (const dim of ATTR_KEYS) {
    const k = dominant(kept, dim);
    if (k && k.share >= 0.5 && email.attrs[dim] === k.value) s += 1;
  }
  return s;
}
