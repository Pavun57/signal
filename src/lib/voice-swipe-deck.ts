import { countWords, type SwipeEmail } from "@/lib/voice-swipe";

/**
 * Seed drafts for the swipe flow.
 *
 * TEMPORARY. In the built version these come from the model, generated against
 * the campaign's ICP and offering and regenerated between batches so later
 * drafts reflect what has already been kept. Until that route exists this fixed
 * set stands in, which is why the run can exhaust rather than converge — a real
 * one keeps writing.
 *
 * They vary across all five axes on purpose. A deck that differs only in
 * wording teaches nothing, because every swipe would carry the same meaning.
 */
const RAW: Omit<SwipeEmail, "words">[] = [
  {
    id: "d01",
    subject: "Loved the Fernpath changelog",
    attrs: {
      opener: "compliment",
      tone: "formal",
      close: "cta",
      greeting: "hi",
      signoff: "best",
    },
    body: `Hi Dana,

Huge fan of what your team has been shipping. The metering work in last month's changelog was genuinely impressive, and it's clear Fernpath is thinking hard about developer experience.

We help API companies like yours turn usage data into billing without building it in-house. Teams usually save a quarter of engineering time.

Would love to circle back next week and see if it's worth a conversation.

Best,
Jay`,
  },
  {
    id: "d02",
    subject: "metering in your changelog",
    attrs: {
      opener: "signal",
      tone: "neutral",
      close: "question",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

You shipped usage metering last month, which usually means billing is about to become someone's full-time job.

Arbor does the metering-to-invoice part so your team doesn't have to.

Worth fifteen minutes next week?

Jay`,
  },
  {
    id: "d03",
    subject: "the billing glue problem",
    attrs: {
      opener: "problem",
      tone: "neutral",
      close: "question",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

Most API teams hit the same wall: usage data in one system, invoices in another, and an engineer permanently gluing them together.

Arbor is that glue. Metering in, invoices out.

Is that a problem at Fernpath yet, or still ahead of you?

Jay`,
  },
  {
    id: "d04",
    subject: "a quarter of an engineer",
    attrs: {
      opener: "data",
      tone: "neutral",
      close: "question",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

Across the API companies we work with, billing glue eats about a quarter of one engineer, permanently. It rarely lands on a roadmap because it never quite ships.

Arbor takes that piece off you.

Is that roughly what it's costing you?

Jay`,
  },
  {
    id: "d05",
    subject: "how billing becomes a full-time job",
    attrs: {
      opener: "story",
      tone: "warm",
      close: "question",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

A VP Eng told me last month that billing had quietly become one engineer's entire job. Nobody decided that; it accumulated, one edge case at a time.

We built Arbor for exactly that drift. Metering to invoice, handled.

Sound familiar?

Jay`,
  },
  {
    id: "d06",
    subject: "metering → billing",
    attrs: {
      opener: "signal",
      tone: "blunt",
      close: "question",
      greeting: "firstname",
      signoff: "none",
    },
    body: `Dana,

Saw the metering work in your changelog. That's usually when billing becomes someone's full-time job.

Arbor handles metering to invoice. Worth fifteen minutes?`,
  },
  {
    id: "d07",
    subject: "how are you handling invoicing?",
    attrs: {
      opener: "question",
      tone: "neutral",
      close: "question",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

How are you handling the metering-to-invoice step today: built in-house, or still manual?

Asking because you shipped metering last month, and that's usually where it starts getting expensive.

Jay`,
  },
  {
    id: "d08",
    subject: "what three other API teams did",
    attrs: {
      opener: "social",
      tone: "neutral",
      close: "cta",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

Three API companies that shipped usage metering this year moved the invoicing side to Arbor rather than build it. Same pattern each time: metering is the fun part, billing is the tax.

Happy to share what those migrations looked like.

Jay`,
  },
  {
    id: "d09",
    subject: "hope the metering launch went well",
    attrs: {
      opener: "compliment",
      tone: "warm",
      close: "question",
      greeting: "hi",
      signoff: "name",
    },
    body: `Hi Dana,

Hope the metering launch went smoothly. Those are never as clean as the changelog makes them look.

If the invoicing side is next on your list, that's the bit we do. Arbor turns metering into invoices without another quarter of engineering.

Any appetite for a quick chat?

Jay`,
  },
  {
    id: "d10",
    subject: "Usage-based billing infrastructure for Fernpath",
    attrs: {
      opener: "pitch",
      tone: "formal",
      close: "cta",
      greeting: "dear",
      signoff: "regards",
    },
    body: `Dear Dana,

I am reaching out regarding Fernpath's recent usage metering implementation. Arbor provides usage-based billing infrastructure for API-first organisations, enabling accurate invoicing without additional engineering investment.

I would welcome the opportunity to discuss how this might align with Fernpath's roadmap this quarter.

Kind regards,
Jay`,
  },
  {
    id: "d11",
    subject: "the other half of metering",
    attrs: {
      opener: "signal",
      tone: "neutral",
      close: "question",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

You shipped metering last month. The invoicing half is usually three months of work and then permanent maintenance.

Arbor does that half. Most teams your size get an engineer back.

Worth fifteen minutes?

Jay`,
  },
  {
    id: "d12",
    subject: "did you build the invoicing side too?",
    attrs: {
      opener: "signal",
      tone: "blunt",
      close: "question",
      greeting: "firstname",
      signoff: "none",
    },
    body: `Dana,

Saw the metering work. Did you build the invoicing side too, or is that still coming?`,
  },
  {
    id: "d13",
    subject: "billing is the tax on metering",
    attrs: {
      opener: "problem",
      tone: "blunt",
      close: "statement",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

Metering is the interesting problem. Invoicing is the tax you pay for having solved it: proration, credits, mid-cycle plan changes, all landing on whoever shipped the meter.

Arbor is that tax, paid.

I'll leave the door open.

Jay`,
  },
  {
    id: "d14",
    subject: "quick one on Fernpath's billing",
    attrs: {
      opener: "pitch",
      tone: "warm",
      close: "cta",
      greeting: "hi",
      signoff: "best",
    },
    body: `Hi Dana,

I wanted to introduce Arbor. We handle usage-based billing for API companies, from raw metering events through to invoices your finance team can actually reconcile.

Given Fernpath shipped metering recently, the timing seemed worth a note.

Would you be open to a short call next week?

Best,
Jay`,
  },
  {
    id: "d15",
    subject: "metering shipped. now the invoices",
    attrs: {
      opener: "signal",
      tone: "blunt",
      close: "question",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

Metering shipped last month. Invoicing is the half that never makes the changelog.

Arbor does that half.

Fifteen minutes?

Jay`,
  },
  {
    id: "d16",
    subject: "after the metering launch",
    attrs: {
      opener: "signal",
      tone: "warm",
      close: "cta",
      greeting: "hi",
      signoff: "name",
    },
    body: `Hi Dana,

Saw metering went out last month, and that's a hard one to get right, so nice work.

The invoicing half is what we do. Arbor turns those events into invoices without another quarter of engineering.

Would a short call next week be useful?

Jay`,
  },
  {
    id: "d17",
    subject: "three months, then forever",
    attrs: {
      opener: "data",
      tone: "blunt",
      close: "statement",
      greeting: "firstname",
      signoff: "none",
    },
    body: `Dana,

Building invoicing on top of metering runs about three months, then never stops needing maintenance. That second number is the one teams underestimate.

Arbor is the alternative.

I'll leave it there.`,
  },
  {
    id: "d18",
    subject: "the part of billing nobody owns",
    attrs: {
      opener: "problem",
      tone: "warm",
      close: "cta",
      greeting: "hi",
      signoff: "best",
    },
    body: `Hi Dana,

Billing has a habit of landing in the gap between engineering and finance: everyone touches it, nobody owns it, and it quietly eats a roadmap slot every quarter.

Arbor takes that gap off the table for API companies like Fernpath.

Could I show you what that looks like?

Best,
Jay`,
  },
  {
    id: "d19",
    subject: "who owns invoicing at Fernpath?",
    attrs: {
      opener: "question",
      tone: "blunt",
      close: "question",
      greeting: "firstname",
      signoff: "none",
    },
    body: `Dana,

Who ends up owning invoicing at Fernpath: your team, or finance?

Metering shipped last month, so it's about to matter.

Worth a quick word?`,
  },
  {
    id: "d20",
    subject: "they'd have paid to skip that part",
    attrs: {
      opener: "story",
      tone: "neutral",
      close: "cta",
      greeting: "firstname",
      signoff: "name",
    },
    body: `Dana,

A team we work with shipped metering in March and spent the next two quarters building invoicing around it. Afterwards they told me they'd have paid almost anything to skip that part.

That part is what Arbor is.

Happy to walk you through it.

Jay`,
  },
];

export const SEED_DECK: SwipeEmail[] = RAW.map((e) => ({
  ...e,
  words: countWords(e.body),
}));

export const SEED_RECIPIENT = "Dana Whitfield · VP Engineering, Fernpath";
