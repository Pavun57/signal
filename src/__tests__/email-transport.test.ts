import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/crypto";
import { resolveSenderConfig } from "@/lib/services/email-transport";

function fakeSupabase(row: unknown, error: { message: string } | null = null) {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "maybeSingle"]) {
    builder[name] = () => builder;
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      error ? { data: null, error } : { data: row, error: null },
    ).then(resolve);
  return { from: () => builder } as never;
}

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.EMAIL_CREDENTIALS_KEY;
  process.env.EMAIL_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterEach(() => {
  process.env.EMAIL_CREDENTIALS_KEY = savedKey;
});

describe("resolveSenderConfig", () => {
  it("resolves a connected gmail sender with a decrypted app password", async () => {
    const result = await resolveSenderConfig(
      fakeSupabase({
        gmail_address: "jay@sahnan.co",
        gmail_app_password_enc: encryptSecret("abcd efgh ijkl mnop"),
        gmail_connected_at: "2026-07-29T00:00:00Z",
        from_name: "Jay Sahnan",
        reply_to_email: null,
        daily_send_limit: 25,
      }),
      "user_1",
    );
    expect(result).toEqual({
      address: "jay@sahnan.co",
      appPassword: "abcd efgh ijkl mnop",
      fromName: "Jay Sahnan",
      replyTo: null,
      dailyLimit: 25,
      connectedAt: "2026-07-29T00:00:00Z",
      sendingPaused: false,
      sendWindowStart: null,
      sendWindowEnd: null,
      sendTimezone: null,
      sendWindowScope: "sender" as const,
    });
  });

  it("errors when gmail is not connected", async () => {
    const result = await resolveSenderConfig(
      fakeSupabase({
        gmail_address: null,
        gmail_app_password_enc: null,
        gmail_connected_at: null,
        from_name: null,
        reply_to_email: null,
        daily_send_limit: 30,
      }),
      "user_1",
    );
    expect(result).toEqual({ error: expect.stringContaining("connect") });
  });

  it("returns an error (not a throw) for undecryptable credentials", async () => {
    const result = await resolveSenderConfig(
      fakeSupabase({
        gmail_address: "jay@sahnan.co",
        gmail_app_password_enc: "not.valid.ciphertext",
        gmail_connected_at: null,
        from_name: null,
        reply_to_email: null,
        daily_send_limit: 30,
      }),
      "user_1",
    );
    expect(result).toEqual({ error: expect.stringContaining("Reconnect") });
  });

  it("errors when no settings row exists", async () => {
    const result = await resolveSenderConfig(fakeSupabase(null), "user_1");
    expect(result).toEqual({ error: expect.stringContaining("connect") });
  });

  it("defaults the daily limit to 30", async () => {
    const result = await resolveSenderConfig(
      fakeSupabase({
        gmail_address: "jay@sahnan.co",
        gmail_app_password_enc: encryptSecret("pw pw pw pw pw pw"),
        gmail_connected_at: null,
        from_name: null,
        reply_to_email: null,
        daily_send_limit: null,
      }),
      "user_1",
    );
    expect(result).toMatchObject({ dailyLimit: 30 });
  });
});

describe("resolveSenderConfig when the settings read fails", () => {
  it("reports a retryable failure, not an unconfigured mailbox", async () => {
    // "Email is not configured. Go to Settings" for a DB blip sends a fully
    // connected user to re-do setup (and reset their warmup clock), and the
    // followups cron records the same misleading reason for every send.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await resolveSenderConfig(
      fakeSupabase(null, { message: "connection reset by peer" }),
      "user_1",
    );

    expect("error" in result && result.error).toContain("connection reset");
    expect("error" in result && result.error).toMatch(/retry/i);
    expect("error" in result && result.error).not.toMatch(/not configured/i);
    quiet.mockRestore();
  });
});
