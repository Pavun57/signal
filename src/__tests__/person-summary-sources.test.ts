import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * summarizePerson decides what title enrichment writes back onto people.title,
 * and every source used to reach it as an undated blob.
 *
 * Victor Lue's material held an archived snapshot dated 2026-03-29 saying
 * "Customer Engineer at Browserbase, May 2025 - Present" next to a live
 * LinkedIn headline saying "Product Support at Anthropic". With nothing to
 * order them by, the model picked the archived one, called Anthropic a
 * previous employer, and enrichment wrote the stale title back over the
 * correct one.
 */

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => ({
  // apiSafeSchema needs the real asSchema/jsonSchema helpers.
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: () => "model" }));
// llmTimeout() returns AbortSignal.timeout(...), whose pending timer outlives a
// test that throws before the SDK consumes the signal, and vitest then
// attributes the abort to the test. The timeout is not what is under test.
vi.mock("@/lib/utils/timeout", () => ({ llmTimeout: () => undefined }));
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  estimateClaudeCostFromUsage: () => 0,
}));

import { summarizePerson } from "@/lib/services/enrichment-summarizer";

function reply(object: Record<string, unknown>) {
  generateObjectMock.mockResolvedValue({
    object,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

const promptOf = () =>
  (generateObjectMock.mock.calls[0][0] as { prompt: string }).prompt;

const TODAY = new Date().toISOString().slice(0, 10);

describe("dated sources", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    reply({
      summary: "A summary.",
      currentTitle: "Product Support",
      sourcesConflict: false,
    });
  });

  it("puts each source's date next to its title", async () => {
    await summarizePerson({
      name: "Victor Lue",
      news: [
        {
          title: "Archived profile",
          url: "https://web.archive.org/victor",
          publishedDate: "2026-03-29",
          text: "Customer Engineer at Browserbase, May 2025 - Present",
        },
      ],
    });

    expect(promptOf()).toContain("Archived profile (published: 2026-03-29)");
  });

  it("says a source is undated rather than dropping the field", async () => {
    // A silently absent date reads to the model as "not applicable", which is
    // exactly how an undated archive page ended up outranking a live headline.
    await summarizePerson({
      name: "Victor Lue",
      background: [
        {
          title: "Some page",
          url: "https://example.com/victor",
          publishedDate: null,
          text: "Background text.",
        },
      ],
    });

    expect(promptOf()).toContain("Some page (published: undated)");
  });

  it("dates the live LinkedIn headline as scraped today", async () => {
    // The headline is the one source we know is current. Handing it over
    // undated leaves the model no reason to prefer it over an archive.
    await summarizePerson({
      name: "Victor Lue",
      linkedinHeadline: "Product Support at Anthropic",
    });

    expect(promptOf()).toContain(`scraped today, ${TODAY}`);
  });

  it("tells the model the freshest source wins", async () => {
    await summarizePerson({
      name: "Victor Lue",
      linkedinHeadline: "Product Support at Anthropic",
    });

    const prompt = promptOf();
    expect(prompt).toMatch(/freshest source wins/i);
    expect(prompt).toMatch(/only proves where they worked on the day/i);
  });

  it("reports the conflict the model found", async () => {
    reply({
      summary: "A summary.",
      currentTitle: "Customer Engineer",
      sourcesConflict: true,
    });

    const out = await summarizePerson({
      name: "Victor Lue",
      linkedinHeadline: "Product Support at Anthropic",
    });

    expect(out?.sourcesConflict).toBe(true);
  });

  it("reports no conflict when the model found none", async () => {
    const out = await summarizePerson({
      name: "Lindsay Gilson",
      linkedinHeadline: "Head of Ops at Browserbase",
    });

    expect(out?.sourcesConflict).toBe(false);
  });
});
