import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceProfile } from "@/lib/types/email-voice";

const CAMPAIGN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SEQUENCE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => ({
  getSupabaseAndUser: vi.fn(),
  loadVoiceProfile: vi.fn(),
  composeEmail: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: h.getSupabaseAndUser,
  createClient: vi.fn(),
}));
vi.mock("@/lib/email-composition/load-voice", () => ({
  loadVoiceProfile: h.loadVoiceProfile,
}));
vi.mock("@/lib/email-composition/compose", () => ({
  composeEmail: h.composeEmail,
  // The real mapConcurrent is a plain helper; a sequential stand-in keeps the
  // fan-out deterministic without pulling the real module in.
  mapConcurrent: async <T, R>(
    items: T[],
    _limit: number,
    fn: (item: T) => Promise<R>,
  ) => {
    const out: R[] = [];
    for (const item of items) out.push(await fn(item));
    return out;
  },
}));
vi.mock("@/lib/email-composition/save", () => ({
  saveDraft: vi.fn().mockResolvedValue({ ok: true, draftId: "d1" }),
}));

import { draftEmailsForSequence } from "@/lib/tools/sequence-tools";

/**
 * Minimal read stubs for the tables the fan-out touches before it composes.
 * Only the shapes the gate depends on matter here — the drafting path itself is
 * covered by draft-sequence-emails-shape.test.ts.
 */
function stubClient() {
  const from = (table: string) => {
    const rows: Record<string, unknown> = {
      sequences: { id: SEQUENCE, name: "Q3 outbound", campaign_id: CAMPAIGN },
      campaigns: {
        id: CAMPAIGN,
        name: "UK Series B+",
        icp: {},
        offering: {},
        positioning: {},
        profile_id: null,
        user_id: "user_1",
      },
    };
    const single = async () => ({ data: rows[table] ?? null, error: null });
    const listed = async () => ({
      data:
        table === "sequence_steps"
          ? [{ id: "st1", step_number: 1, delay_days: 0, condition: null }]
          : table === "sequence_enrollments"
            ? [{ id: "en1", person_id: "p1", campaign_people_id: "cp1" }]
            : table === "people"
              ? [
                  {
                    id: "p1",
                    name: "Alice",
                    title: "CTO",
                    work_email: "a@acme.com",
                    personal_email: null,
                    organization_id: "o1",
                    enrichment_data: {},
                  },
                ]
              : table === "organizations"
                ? [
                    {
                      id: "o1",
                      name: "Acme",
                      domain: "acme.com",
                      enrichment_data: {},
                    },
                  ]
                : [],
      error: null,
    });

    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "order"]) {
      builder[name] = () => builder;
    }
    builder.single = single;
    builder.maybeSingle = single;
    // `.eq(...)`/`.order(...)` are awaited directly on list reads.
    builder.then = (res: (v: unknown) => unknown) => listed().then(res);
    return builder;
  };
  return { from };
}

const campaignVoice: VoiceProfile = {
  id: "v1",
  user_id: "user_1",
  campaign_id: CAMPAIGN,
  instructions: "Open on the signal.",
  summary: "Signal-first",
  source_transcript: null,
  created_at: "2026-07-30T00:00:00Z",
  updated_at: "2026-07-30T00:00:00Z",
};

const userDefault: VoiceProfile = {
  ...campaignVoice,
  id: "v0",
  campaign_id: null,
};

type Result = {
  needsVoice?: boolean;
  campaignId?: string;
  message?: string;
  usingFallbackVoice?: boolean;
  voiceScope?: string;
  voiceSkipped?: boolean;
  drafted?: number;
};

const run = (args: Record<string, unknown>) =>
  draftEmailsForSequence.execute!(
    { sequenceId: SEQUENCE, concurrency: 1, ...args },
    {} as never,
  ) as unknown as Promise<Result>;

beforeEach(() => {
  vi.clearAllMocks();
  h.getSupabaseAndUser.mockResolvedValue({
    supabase: stubClient(),
    user: { id: "user_1", email: "u@example.com" },
  });
  h.composeEmail.mockResolvedValue({
    ok: true,
    email: {
      subject: "acme hiring",
      bodyHtml: "<p>hi</p>",
      bodyText: "hi",
      aiReasoning: "signal",
    },
  });
});

describe("draftEmailsForSequence voice gate", () => {
  it("refuses to draft when the campaign has no voice and no choice was made", async () => {
    h.loadVoiceProfile.mockResolvedValue(null);

    const result = await run({});

    expect(result.needsVoice).toBe(true);
    expect(result.campaignId).toBe(CAMPAIGN);
    // The whole point of the gate: no drafts exist yet when the user decides.
    expect(h.composeEmail).not.toHaveBeenCalled();
  });

  it("tells the agent the fallback is a different campaign's voice", async () => {
    // A user-level default exists, but it was built for another campaign — the
    // user should be told that before choosing to skip.
    h.loadVoiceProfile.mockResolvedValue(userDefault);

    const result = await run({});

    expect(result.needsVoice).toBe(true);
    expect(result.usingFallbackVoice).toBe(true);
    expect(result.message).toContain("default voice");
    expect(h.composeEmail).not.toHaveBeenCalled();
  });

  it("does not invent reply-rate statistics in the nudge", async () => {
    // The base rules are built on real research; the gate must not manufacture
    // a number for "having a voice profile", which nothing measures.
    h.loadVoiceProfile.mockResolvedValue(null);

    const { message = "" } = await run({});

    expect(message).not.toMatch(/\d+\s*%/);
    expect(message).not.toMatch(/\dx\b/);
  });

  it("drafts without gating once the user has skipped", async () => {
    h.loadVoiceProfile.mockResolvedValue(null);

    const result = await run({ voiceChoice: "skip" });

    expect(result.needsVoice).toBeUndefined();
    expect(result.voiceSkipped).toBe(true);
    expect(result.voiceScope).toBe("base-rules");
    expect(h.composeEmail).toHaveBeenCalled();
  });

  it("reports the fallback scope when skipping with a user default", async () => {
    h.loadVoiceProfile.mockResolvedValue(userDefault);

    const result = await run({ voiceChoice: "skip" });

    expect(result.voiceScope).toBe("user-default");
    expect(result.message).toContain("default voice");
  });

  it("never gates when the campaign has its own voice", async () => {
    h.loadVoiceProfile.mockResolvedValue(campaignVoice);

    const result = await run({});

    expect(result.needsVoice).toBeUndefined();
    expect(result.voiceScope).toBe("campaign");
    expect(h.composeEmail).toHaveBeenCalled();
  });

  it("passes the campaign id to the voice loader", async () => {
    h.loadVoiceProfile.mockResolvedValue(campaignVoice);

    await run({});

    expect(h.loadVoiceProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      CAMPAIGN,
    );
  });
});
