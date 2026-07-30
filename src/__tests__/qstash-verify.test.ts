import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());

vi.mock("@upstash/qstash", () => ({
  Client: class {},
  Receiver: class {
    verify = verifyMock;
  },
}));

import { verifyQStashSignature } from "@/lib/services/qstash";

/** Builds an unsigned JWT-shaped signature whose payload carries `sub`. */
function fakeSignature(sub?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(sub ? { sub } : {})).toString(
    "base64url",
  );
  return `${header}.${payload}.fakesig`;
}

function makeRequest(url: string, body: string, signature?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: signature ? { "upstash-signature": signature } : {},
    body,
  });
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.cur = process.env.QSTASH_CURRENT_SIGNING_KEY;
  savedEnv.next = process.env.QSTASH_NEXT_SIGNING_KEY;
  process.env.QSTASH_CURRENT_SIGNING_KEY = "sig_current";
  process.env.QSTASH_NEXT_SIGNING_KEY = "sig_next";
  verifyMock.mockReset();
  verifyMock.mockResolvedValue(true);
});

afterEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = savedEnv.cur;
  process.env.QSTASH_NEXT_SIGNING_KEY = savedEnv.next;
});

describe("verifyQStashSignature", () => {
  it("returns null for an empty body (console-created schedules send none)", async () => {
    const sig = fakeSignature("https://app.example.com/api/email/track");
    const req = makeRequest("https://internal.host/api/email/track", "", sig);

    await expect(verifyQStashSignature(req)).resolves.toBeNull();
    expect(verifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ signature: sig, body: "" }),
    );
  });

  it("returns the parsed body for JSON payloads", async () => {
    const sig = fakeSignature("https://app.example.com/api/outreach/process");
    const req = makeRequest(
      "https://internal.host/api/outreach/process",
      JSON.stringify({ type: "followups" }),
      sig,
    );

    await expect(verifyQStashSignature(req)).resolves.toEqual({
      type: "followups",
    });
  });

  it("rejects a signature issued for a different route", async () => {
    const sig = fakeSignature("https://app.example.com/api/tracking/run");
    const req = makeRequest(
      "https://app.example.com/api/outreach/process",
      "{}",
      sig,
    );

    await expect(verifyQStashSignature(req)).rejects.toThrow(
      /different route/i,
    );
  });

  it("accepts host differences as long as the path matches", async () => {
    const sig = fakeSignature("https://prod-alias.com/api/email/cleanup");
    const req = makeRequest(
      "https://deploy-abc123.vercel.app/api/email/cleanup",
      "",
      sig,
    );

    await expect(verifyQStashSignature(req)).resolves.toBeNull();
  });

  it("throws when the signature is invalid", async () => {
    verifyMock.mockResolvedValue(false);
    const sig = fakeSignature("https://app.example.com/api/email/track");
    const req = makeRequest(
      "https://app.example.com/api/email/track",
      "{}",
      sig,
    );

    await expect(verifyQStashSignature(req)).rejects.toThrow(
      /invalid qstash signature/i,
    );
  });

  it("throws when the signature header is missing", async () => {
    const req = makeRequest("https://app.example.com/api/email/track", "{}");

    await expect(verifyQStashSignature(req)).rejects.toThrow(
      /missing upstash-signature/i,
    );
  });
});
