import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * selectContactsForSignal decides who gets emailed after a signal fires, and
 * `maxPicks` is the caller's spend/blast-radius cap. The cap and the no-invented
 * -IDs rule are enforced here, in code: a sentence in the prompt is a request,
 * not a guarantee, and the composer drafts one email per pick that survives.
 */

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));
vi.mock("@/lib/ai/models", () => ({
  getLLM: () => "model",
  AI_MODEL: "test-model",
  AI_BASE_URL: "https://api.anthropic.com/v1",
  AI_INPUT_PRICE_PER_MTOK: 3.0,
  AI_OUTPUT_PRICE_PER_MTOK: 15.0,
}));
vi.mock("@/lib/utils/timeout", () => ({ llmTimeout: () => undefined }));
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  estimateLlmCostFromUsage: () => 0,
}));

import {
  selectContactsForSignal,
  type Candidate,
} from "@/lib/services/contact-selector";

const candidate = (id: string): Candidate => ({
  personId: id,
  name: `Person ${id}`,
  title: "VP Sales",
  workEmail: `${id}@acme.com`,
  linkedinUrl: null,
  priorityScore: null,
  enrichmentSummary: null,
});

const pick = (id: string) => ({
  personId: id,
  rationale: "fits the signal",
  priority: 1,
});

function reply(picks: unknown[]) {
  generateObjectMock.mockResolvedValue({
    object: { picks },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

const input = (
  over: Partial<Parameters<typeof selectContactsForSignal>[0]>,
) => ({
  reason: "hired a new CRO",
  signalName: "Leadership change",
  signalCategory: "hiring",
  candidates: [candidate("a"), candidate("b"), candidate("c")],
  ...over,
});

beforeEach(() => generateObjectMock.mockReset());

describe("selectContactsForSignal", () => {
  it("clamps the picks to maxPicks", async () => {
    // The schema's array is unbounded and "pick up to N" is only a sentence in
    // the prompt. Every extra pick that leaks through becomes a drafted email.
    reply([pick("a"), pick("b"), pick("c")]);

    const { picks } = await selectContactsForSignal(input({ maxPicks: 2 }));

    expect(picks).toHaveLength(2);
    expect(picks.map((p) => p.personId)).toEqual(["a", "b"]);
  });

  it("drops a personId the model repeats", async () => {
    // A duplicated pick drafts two emails to the same person, and with a
    // clamp in place it can also crowd a real second contact out of the list.
    reply([pick("a"), pick("a"), pick("b")]);

    const { picks } = await selectContactsForSignal(input({ maxPicks: 3 }));

    expect(picks.map((p) => p.personId)).toEqual(["a", "b"]);
  });

  it("drops invented personIds", async () => {
    reply([pick("ghost"), pick("b")]);

    const { picks } = await selectContactsForSignal(input({ maxPicks: 3 }));

    expect(picks.map((p) => p.personId)).toEqual(["b"]);
  });

  it("defaults maxPicks to one", async () => {
    reply([pick("a"), pick("b")]);

    const { picks } = await selectContactsForSignal(input({}));

    expect(picks).toHaveLength(1);
  });
});
