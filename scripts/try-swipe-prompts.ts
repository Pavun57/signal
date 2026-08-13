/**
 * Exercises the two swipe prompts against a real campaign, before any UI is
 * built around them.
 *
 * The question this answers is narrow and load-bearing: does the model produce
 * drafts that differ enough to make a swipe mean something? A batch where every
 * draft opens the same way teaches nothing, and no interface can rescue that.
 * It then simulates a picky user and checks the batch actually narrows, and
 * finally prints the skill written from the whole run.
 *
 *   pnpm tsx scripts/try-swipe-prompts.ts            # uses your latest campaign
 *   pnpm tsx scripts/try-swipe-prompts.ts <uuid>     # a specific one
 */
import { config } from "dotenv";
import { generateObject } from "ai";
import type { z } from "zod";

import { AI_MODEL, getLLM } from "../src/lib/ai/models";
import { salvageObject } from "../src/lib/ai/salvage-object";
import {
  BatchSchema,
  SkillSchema,
  buildBatchPrompt,
  buildBatchSystem,
  buildSkillPrompt,
  buildSkillSystem,
  normaliseInstructions,
  personaLabel,
  type Draft,
  type JudgedDraft,
  type Persona,
  type SwipeCampaign,
  type SwipeSenderContext,
  type SwipeTranscript,
} from "../src/lib/email-skills/swipe-prompts";

config({ path: ".env.local" });

const AXES = ["opener", "tone", "close", "greeting", "signoff"] as const;

async function generate<T>(
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
  maxOutputTokens: number,
): Promise<T> {
  try {
    const { object } = await generateObject({
      model: getLLM(),
      schema,
      system,
      prompt,
      maxRetries: 0,
      maxOutputTokens,
    });
    return object;
  } catch (err) {
    // Providers intermittently wrap a correct payload in a `value` key.
    const salvaged = salvageObject(err, schema);
    if (salvaged) return salvaged;
    throw err;
  }
}

/** The measurement that matters: how much of the axis space did the batch use? */
function report(drafts: Draft[], label: string) {
  console.log(`\n${"─".repeat(72)}\n${label}: ${drafts.length} drafts\n`);

  for (const d of drafts) {
    const axes = AXES.map((a) => `${a}:${d.axes[a]}`).join("  ");
    const words = d.body.trim().split(/\s+/).length;
    console.log(`  ▸ ${d.subject}   [${words}w]`);
    console.log(`    ${axes}`);
    console.log(
      d.body
        .split("\n")
        .map((l) => `    │ ${l}`)
        .join("\n"),
    );
    console.log("");
  }

  const spread = AXES.map((a) => {
    const values = new Set(drafts.map((d) => d.axes[a]));
    return `${a}=${values.size}`;
  }).join("  ");
  console.log(`  VARIATION  ${spread}   (distinct values per axis)`);

  // Pairwise: any two drafts identical on all five axes are wasted slots.
  let clashes = 0;
  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      const same = AXES.every((a) => drafts[i].axes[a] === drafts[j].axes[a]);
      if (same) clashes += 1;
    }
  }
  const openers = new Set(drafts.map((d) => d.axes.opener)).size;
  console.log(
    `  IDENTICAL PAIRS  ${clashes}${clashes ? "  ← wasted slots" : ""}` +
      `   DISTINCT OPENERS  ${openers}/${drafts.length}` +
      `${openers < Math.min(4, drafts.length) ? "  ← too narrow" : ""}`,
  );
}

async function loadCampaign(id?: string): Promise<SwipeCampaign | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("No Supabase env. Running without campaign context.\n");
    return null;
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);
  const q = supabase
    .from("campaigns")
    .select("name, icp, offering, positioning");
  const { data } = id
    ? await q.eq("id", id).maybeSingle()
    : await q.order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) {
    console.log("No campaign found. Running without context.\n");
    return null;
  }
  return data as SwipeCampaign;
}

/**
 * Always supplied, campaign or not. The sender's name is the first thing you
 * notice is wrong in a draft, so it must not depend on a table lookup
 * succeeding. The recipient is deliberately absent: the model invents a
 * fictional persona per batch, which is part of what this script exercises.
 */
const SENDER_CONTEXT: SwipeSenderContext = {
  sender: {
    name: "Jay",
    roleTitle: "Founder",
    companyName: "Arbor",
    offeringSummary: "usage metering to invoice for API companies",
  },
};

async function run() {
  const campaign = await loadCampaign(process.argv[2]);
  console.log(`Campaign: ${campaign?.name ?? "(none)"}`);
  console.log(`Model:    ${AI_MODEL}`);

  const transcript: SwipeTranscript = { judged: [], instructions: [] };

  // ── Batch 1: cold start, maximum spread expected ──────────────────────────
  const t0 = Date.now();
  const first = await generate<{ persona?: Persona; drafts: Draft[] }>(
    BatchSchema,
    buildBatchSystem(campaign, SENDER_CONTEXT),
    buildBatchPrompt(transcript, 6),
    8_000,
  );
  console.log(`\n(batch 1 took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  // The probe drives the invented path, where a persona is always expected.
  const firstPersona = first.persona;
  if (!firstPersona) throw new Error("batch 1 returned no persona");
  console.log(`Invented persona: ${personaLabel(firstPersona)}`);
  report(first.drafts, "BATCH 1: cold start");

  // ── Simulate a picky user: keeps blunt/signal, passes the rest ────────────
  const judged: JudgedDraft[] = first.drafts.map((d) => ({
    subject: d.subject,
    body: d.body,
    axes: d.axes,
    kept: d.axes.opener === "signal" || d.axes.tone === "blunt",
    personaLabel: personaLabel(firstPersona),
  }));
  transcript.judged.push(...judged);
  transcript.instructions.push(
    "I like blunt but not too formal",
    "dont use em dashes",
  );
  // The first of those is the exact input that broke the regex engine: it
  // deleted the blunt drafts because a negation appeared in the sentence.
  const notes = judged.find((d) => !d.kept);
  if (notes) {
    notes.notes = [
      {
        phrase: notes.body.split(/\s+/).slice(0, 4).join(" "),
        note: "I'd never open like this",
      },
    ];
  }

  console.log(
    `\nSimulated user kept ${judged.filter((d) => d.kept).length}/${judged.length}, ` +
      `and typed: ${transcript.instructions.map((i) => `“${i}”`).join(", ")}`,
  );

  // ── Batch 2: must narrow AND obey the instructions ────────────────────────
  const t1 = Date.now();
  const second = await generate<{ persona?: Persona; drafts: Draft[] }>(
    BatchSchema,
    buildBatchSystem(campaign, SENDER_CONTEXT),
    buildBatchPrompt(transcript, 4),
    6_000,
  );
  console.log(`\n(batch 2 took ${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  const secondPersona = second.persona;
  if (!secondPersona) throw new Error("batch 2 returned no persona");
  console.log(`Invented persona: ${personaLabel(secondPersona)}`);
  if (personaLabel(secondPersona) === personaLabel(firstPersona)) {
    console.log("  ← PERSONA REUSED (the prompt forbids this)");
  }
  report(second.drafts, "BATCH 2: after keeps + instructions");

  // This measures whether the model obeyed the no-em-dash rule, so it is the
  // one place that has to contain the character. The escape is not enough:
  // the lint rule matches a Literal's cooked value, not its source text.
  // eslint-disable-next-line no-restricted-syntax
  const emDash = second.drafts.filter((d) => d.body.includes("\u2014")).length;
  const formal = second.drafts.filter((d) => d.axes.tone === "formal").length;
  const blunt = second.drafts.filter((d) => d.axes.tone === "blunt").length;
  console.log("\n  INSTRUCTION COMPLIANCE");
  console.log(
    `    em dashes present   ${emDash}/${second.drafts.length}  ${emDash ? "← VIOLATION" : "✓"}`,
  );
  console.log(
    `    formal drafts       ${formal}/${second.drafts.length}  ${formal ? "← VIOLATION" : "✓"}`,
  );
  console.log(
    `    blunt kept alive    ${blunt}/${second.drafts.length}  ${blunt ? "✓" : "← over-narrowed"}`,
  );

  // ── The skill ─────────────────────────────────────────────────────────────
  transcript.judged.push(
    ...second.drafts.map((d) => ({
      subject: d.subject,
      body: d.body,
      axes: d.axes,
      kept: d.axes.tone === "blunt",
      personaLabel: personaLabel(secondPersona),
    })),
  );

  const t2 = Date.now();
  const skill = await generate<{ instructions: string; summary: string }>(
    SkillSchema,
    buildSkillSystem(campaign, SENDER_CONTEXT),
    buildSkillPrompt(transcript),
    4_000,
  );
  console.log(`\n(skill took ${((Date.now() - t2) / 1000).toFixed(1)}s)`);
  const cleaned = normaliseInstructions(skill.instructions);
  const rawLines = skill.instructions
    .split("\n")
    .filter((l) => l.trim()).length;
  const keptLines = cleaned.split("\n").length;

  console.log(`\n${"─".repeat(72)}\nTHE SKILL\n`);
  console.log(`  summary: ${skill.summary}\n`);
  console.log(
    cleaned
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  if (rawLines !== keptLines) {
    console.log(`\n  (deduped ${rawLines - keptLines} repeated rule(s))`);
  }
  console.log(`\n${"─".repeat(72)}`);
}

run().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
