import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_INTERVIEW_TURNS,
  type InterviewMove,
  type InterviewTurn,
} from "@/lib/types/email-voice";

// Hoisted so the vi.mock factories below can reach these without tripping
// temporal-dead-zone ordering.
const h = vi.hoisted(() => ({
  generateObject: vi.fn(),
  getSupabaseAndUser: vi.fn(),
}));

// NoObjectGeneratedError is needed because the route's salvage path imports it
// to recognise a wrapped-but-valid payload. A bare generateObject mock leaves it
// undefined and every test in this file fails on the import.
//
// The stub is a real predicate, not `() => false`. Stubbing it false disabled
// the salvage path in every test in this file — which is how an abort-handling
// bug in that path shipped. It matches on the name the real class sets, so a
// test can opt in by throwing `schemaRejection(...)`.
vi.mock("ai", () => ({
  generateObject: h.generateObject,
  NoObjectGeneratedError: {
    isInstance: (err: unknown) =>
      err instanceof Error && err.name === "AI_NoObjectGeneratedError",
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: h.getSupabaseAndUser,
}));
vi.mock("@/lib/ai/models", () => ({
  MODELS: { EMAIL: "test-email-model" },
}));

import { POST } from "@/app/api/email-skills/interview/route";

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

/**
 * The error the AI SDK throws when a response misses the schema, carrying the
 * raw text the route's salvage path reads back off it.
 */
function schemaRejection(payload: unknown): Error {
  const err = new Error("No object generated");
  err.name = "AI_NoObjectGeneratedError";
  (err as Error & { text: string }).text = JSON.stringify(payload);
  return err;
}

/** Thenable query-builder fake — same pattern as outreach-sender.test.ts. */
function fakeSupabase(responses: Array<{ data?: unknown; error?: unknown }>) {
  let i = 0;
  const calls: RecordedCall[] = [];

  const from = (table: string) => {
    const call: RecordedCall = { table, ops: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const name of [
      "select",
      "eq",
      "order",
      "limit",
      "upsert",
      "single",
      "maybeSingle",
    ]) {
      builder[name] = (...args: unknown[]) => {
        call.ops.push({ name, args });
        return builder;
      };
    }
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) =>
      Promise.resolve(responses[i++] ?? { data: null, error: null }).then(
        resolve,
        reject,
      );
    return builder;
  };

  return { client: { from }, calls };
}

const campaign = {
  data: {
    name: "UK Series B+",
    icp: { geo: "UK" },
    offering: { product: "Signal" },
    positioning: null,
  },
};

/** Signs the request in and queues the reads/writes the route will make. */
function wire(responses: Array<{ data?: unknown; error?: unknown }>) {
  const fake = fakeSupabase(responses);
  h.getSupabaseAndUser.mockResolvedValue({
    supabase: fake.client,
    user: { id: "user_1", email: "u@example.com" },
  });
  return fake;
}

function post(body: unknown, raw?: string) {
  return POST(
    new Request("http://test/api/email-skills/interview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
  );
}

const question: InterviewMove = {
  kind: "question",
  prompt: "What do you refuse to put in a cold email?",
  inputType: "text",
};

async function moveFrom(res: Response) {
  return (await res.json()) as { move?: InterviewMove; error?: string };
}

beforeEach(() => {
  h.generateObject.mockReset();
  h.getSupabaseAndUser.mockReset();
});

describe("POST /api/email-skills/interview", () => {
  it("rejects an unauthenticated request without calling the model", async () => {
    h.getSupabaseAndUser.mockResolvedValue(null);

    const res = await post({ transcript: [] });

    expect(res.status).toBe(401);
    expect((await moveFrom(res)).error).toBe("Unauthorized");
    expect(h.generateObject).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    wire([campaign]);

    const res = await post(null, "{ not json");

    expect(res.status).toBe(400);
    expect(h.generateObject).not.toHaveBeenCalled();
  });

  it("rejects a body with no transcript array", async () => {
    wire([campaign]);

    const res = await post({ transcript: "nope" });

    expect(res.status).toBe(400);
    expect(h.generateObject).not.toHaveBeenCalled();
  });

  it("rejects a transcript carrying a move the wizard cannot render", async () => {
    wire([campaign]);

    const res = await post({
      transcript: [{ move: { kind: "freeform", text: "hi" } }],
    });

    expect(res.status).toBe(400);
    expect(h.generateObject).not.toHaveBeenCalled();
  });

  // Every kind has to survive the round trip untouched — the wizard renders one
  // branch per kind and has no fallback for a mangled shape.
  const moves: InterviewMove[] = [
    question,
    {
      kind: "question",
      prompt: "Which opener sounds more like you?",
      inputType: "choice",
      choices: ["Signal first", "Problem first"],
    },
    {
      kind: "compare",
      dimension: "story-led vs data-led opener",
      a: { subject: "Series B hiring push", body: "Saw the six roles..." },
      b: {
        subject: "Series B hiring push",
        body: "Six roles in eight weeks...",
      },
    },
    {
      kind: "request_samples",
      prompt: "Paste two or three cold emails you have actually sent.",
    },
  ];

  for (const move of moves) {
    const label =
      move.kind === "question" ? `question (${move.inputType})` : move.kind;

    it(`returns a ${label} move to the client unchanged`, async () => {
      wire([campaign]);
      h.generateObject.mockResolvedValue({ object: { move: move } });

      const res = await post({ transcript: [] });

      expect(res.status).toBe(200);
      expect((await moveFrom(res)).move).toEqual(move);
    });
  }

  it("passes the campaign into the prompt so samples are about the real offer", async () => {
    wire([campaign]);
    h.generateObject.mockResolvedValue({ object: { move: question } });

    await post({ transcript: [] });

    const args = h.generateObject.mock.calls[0][0] as { system: string };
    expect(args.system).toContain("UK Series B+");
  });

  it("still runs when the user has no campaign", async () => {
    wire([{ data: null }]);
    h.generateObject.mockResolvedValue({ object: { move: question } });

    const res = await post({ transcript: [] });

    expect(res.status).toBe(200);
    expect((await moveFrom(res)).move).toEqual(question);
  });

  it("surfaces a model failure as a 500", async () => {
    wire([campaign]);
    h.generateObject.mockRejectedValue(new Error("overloaded"));

    const res = await post({ transcript: [] });

    expect(res.status).toBe(500);
    expect((await moveFrom(res)).error).toBe("overloaded");
  });
});

describe("completing the interview", () => {
  const complete: InterviewMove = {
    kind: "complete",
    instructions:
      "Open on the signal, no greeting line.\nNever say 'circle back'.",
    summary: "Blunt and signal-first, no pleasantries.",
  };
  const transcript: InterviewTurn[] = [{ move: question, answer: "Flattery." }];

  beforeEach(() => {
    h.generateObject.mockReset();
    h.getSupabaseAndUser.mockReset();
  });

  it("upserts the profile with instructions, summary and the transcript", async () => {
    const { calls } = wire([campaign, { error: null }]);
    h.generateObject.mockResolvedValue({ object: { move: complete } });

    const res = await post({ transcript });

    expect(res.status).toBe(200);
    expect((await moveFrom(res)).move).toEqual(complete);

    const write = calls[1];
    expect(write.table).toBe("email_voice_profiles");
    expect(write.ops).toContainEqual({
      name: "upsert",
      args: [
        {
          user_id: "user_1",
          campaign_id: null,
          instructions: complete.instructions,
          summary: complete.summary,
          source_transcript: transcript,
        },
        { onConflict: "user_id,campaign_key" },
      ],
    });
  });

  it("saves a campaign-scoped profile against that campaign", async () => {
    const campaignId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const { calls } = wire([campaign, { error: null }]);
    h.generateObject.mockResolvedValue({ object: { move: complete } });

    await post({ transcript, campaignId });

    // campaign_key is a generated column collapsing NULL onto a sentinel, so a
    // single plain unique constraint covers both scopes. A partial index can't
    // be an ON CONFLICT target here — the client can't repeat its predicate,
    // and the write fails outright.
    expect(calls[1].ops).toContainEqual({
      name: "upsert",
      args: [
        expect.objectContaining({ user_id: "user_1", campaign_id: campaignId }),
        { onConflict: "user_id,campaign_key" },
      ],
    });
  });

  it("grounds samples in the named campaign, not the most recent one", async () => {
    // The bug this whole change exists to fix: the interview used to read the
    // most recently updated campaign, so a voice built for one campaign learned
    // another's angle.
    const campaignId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const { calls } = wire([campaign]);
    h.generateObject.mockResolvedValue({ object: { move: question } });

    await post({ transcript: [], campaignId });

    const read = calls[0];
    expect(read.table).toBe("campaigns");
    expect(read.ops).toContainEqual({ name: "eq", args: ["id", campaignId] });
    expect(read.ops.map((o) => o.name)).not.toContain("order");
  });

  it("rejects a campaignId that is not a uuid", async () => {
    wire([campaign]);

    const res = await post({ transcript: [], campaignId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(h.generateObject).not.toHaveBeenCalled();
  });

  it("reports a failed upsert instead of claiming the profile was saved", async () => {
    wire([campaign, { error: { message: "row-level security violation" } }]);
    h.generateObject.mockResolvedValue({ object: { move: complete } });

    const res = await post({ transcript });
    const body = await moveFrom(res);

    expect(res.status).toBe(500);
    expect(body.error).toBe("row-level security violation");
    expect(body.move).toBeUndefined();
  });

  it("never writes a profile for a non-terminal move", async () => {
    const { calls } = wire([campaign]);
    h.generateObject.mockResolvedValue({ object: { move: question } });

    await post({ transcript });

    expect(calls.map((c) => c.table)).not.toContain("email_voice_profiles");
  });
});

describe("turn cap", () => {
  const capped: InterviewTurn[] = Array.from(
    { length: MAX_INTERVIEW_TURNS },
    (_, i) => ({
      move: { kind: "question", prompt: `q${i}`, inputType: "text" },
      answer: `a${i}`,
    }),
  );

  beforeEach(() => {
    h.generateObject.mockReset();
    h.getSupabaseAndUser.mockReset();
  });

  it("completes at the cap rather than asking again", async () => {
    wire([{ error: null }]);
    h.generateObject.mockResolvedValue({
      object: {
        instructions: "Lead with the number.",
        summary: "Numbers-led.",
      },
    });

    const res = await post({ transcript: capped });
    const body = await moveFrom(res);

    expect(res.status).toBe(200);
    expect(body.move).toEqual({
      kind: "complete",
      instructions: "Lead with the number.",
      summary: "Numbers-led.",
    });
  });

  // The cap guarantees termination, but a synthesis that produces no rules is
  // not a result worth keeping: persisting the placeholder would overwrite a
  // real profile and leave the outreach gate reporting a voice that isn't
  // there, with the previous rules and transcript both unrecoverable. Failing
  // loudly leaves the wizard holding the transcript so the user can retry.
  it("refuses rather than saving a placeholder when the model asks again", async () => {
    const { calls } = wire([{ error: null }]);
    h.generateObject.mockResolvedValue({ object: { move: question } });

    const res = await post({ transcript: capped });

    expect(res.status).toBe(503);
    expect(calls.map((c) => c.table)).not.toContain("email_voice_profiles");
  });

  it("refuses rather than saving a placeholder when the final call fails", async () => {
    const { calls } = wire([{ error: null }]);
    h.generateObject.mockRejectedValue(new Error("overloaded"));

    const res = await post({ transcript: capped });

    expect(res.status).toBe(503);
    expect(calls.map((c) => c.table)).not.toContain("email_voice_profiles");
  });

  it("salvages a wrapped profile at the cap instead of refusing", async () => {
    wire([{ error: null }]);
    h.generateObject.mockRejectedValue(
      schemaRejection({
        value: { instructions: "Lead with the number.", summary: "Numbers." },
      }),
    );

    const res = await post({ transcript: capped });
    const body = await moveFrom(res);

    expect(res.status).toBe(200);
    expect(body.move?.kind).toBe("complete");
  });

  it("skips the campaign read at the cap, no sample copy is needed", async () => {
    const { calls } = wire([{ error: null }]);
    h.generateObject.mockResolvedValue({
      object: {
        instructions: "Lead with the number.",
        summary: "Numbers-led.",
      },
    });

    await post({ transcript: capped });

    expect(calls.map((c) => c.table)).toEqual(["email_voice_profiles"]);
  });
});
