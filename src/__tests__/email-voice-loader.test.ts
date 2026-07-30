import { describe, expect, it } from "vitest";

import { loadVoiceProfile } from "@/lib/email-composition/load-voice";
import type { VoiceProfile } from "@/lib/types/email-voice";

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

/**
 * Minimal thenable query-builder fake: every chained method records itself and
 * awaiting the chain resolves the queued response. Lets us assert the loader
 * scopes its read to the caller's user_id, not just that it returns a row.
 */
function fakeSupabase(response: { data?: unknown; error?: unknown }) {
  const calls: RecordedCall[] = [];

  const from = (table: string) => {
    const call: RecordedCall = { table, ops: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "or", "is", "maybeSingle"]) {
      builder[name] = (...args: unknown[]) => {
        call.ops.push({ name, args });
        return builder;
      };
    }
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) => Promise.resolve(response).then(resolve, reject);
    return builder;
  };

  return { client: { from } as never, calls };
}

const CAMPAIGN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const base = {
  instructions: "Short declarative anchor, then one longer explanatory line.",
  summary: "Blunt, concrete, no filler",
  source_transcript: null,
  created_at: "2026-07-29T00:00:00Z",
  updated_at: "2026-07-29T00:00:00Z",
};

/** The user-level default voice. */
const userDefault: VoiceProfile = {
  ...base,
  id: "11111111-1111-1111-1111-111111111111",
  user_id: "user_abc",
  campaign_id: null,
};

/** A voice interviewed for one specific campaign. */
const campaignVoice: VoiceProfile = {
  ...base,
  id: "22222222-2222-2222-2222-222222222222",
  user_id: "user_abc",
  campaign_id: CAMPAIGN,
  summary: "Signal-first, dev-tools angle",
};

describe("loadVoiceProfile", () => {
  it("scopes the read to the caller and returns their default", async () => {
    const { client, calls } = fakeSupabase({ data: [userDefault] });

    await expect(loadVoiceProfile(client, "user_abc")).resolves.toEqual(
      userDefault,
    );

    expect(calls[0].table).toBe("email_voice_profiles");
    expect(calls[0].ops).toContainEqual({
      name: "eq",
      args: ["user_id", "user_abc"],
    });
    // With no campaign, the default row is the only acceptable answer — picking
    // up some arbitrary campaign's voice would be worse than none.
    expect(calls[0].ops).toContainEqual({
      name: "is",
      args: ["campaign_id", null],
    });
  });

  it("prefers the campaign's voice over the user default", async () => {
    // Row order deliberately puts the default first: resolution must be by
    // campaign_id, not by whatever the DB happened to return first.
    const { client, calls } = fakeSupabase({
      data: [userDefault, campaignVoice],
    });

    await expect(
      loadVoiceProfile(client, "user_abc", CAMPAIGN),
    ).resolves.toEqual(campaignVoice);

    expect(calls[0].ops).toContainEqual({
      name: "or",
      args: [`campaign_id.eq.${CAMPAIGN},campaign_id.is.null`],
    });
  });

  it("falls back to the user default when the campaign has no voice", async () => {
    // This is the skip path: a user who declines the campaign interview still
    // writes in their own voice rather than dropping to the base rules.
    const { client } = fakeSupabase({ data: [userDefault] });

    await expect(
      loadVoiceProfile(client, "user_abc", CAMPAIGN),
    ).resolves.toEqual(userDefault);
  });

  it("returns the campaign voice when there is no user default", async () => {
    const { client } = fakeSupabase({ data: [campaignVoice] });

    await expect(
      loadVoiceProfile(client, "user_abc", CAMPAIGN),
    ).resolves.toEqual(campaignVoice);
  });

  it("returns null when the user has built neither", async () => {
    const { client } = fakeSupabase({ data: [] });

    await expect(loadVoiceProfile(client, "user_abc")).resolves.toBeNull();
  });

  it("returns null on a read error rather than throwing", async () => {
    // A transient DB error should cost a draft its voice, not fail the fan-out.
    const { client } = fakeSupabase({
      data: null,
      error: { message: "connection reset" },
    });

    await expect(loadVoiceProfile(client, "user_abc")).resolves.toBeNull();
  });
});
