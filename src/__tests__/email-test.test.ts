import { describe, expect, it } from "vitest";

import {
  REPLY_SNIPPET_MAX,
  extractReplyText,
  TEST_COOLDOWN_MS,
  checkTestCooldown,
  matchTestReply,
  validateTestRecipient,
} from "@/lib/services/email-test";

describe("validateTestRecipient", () => {
  it("accepts a different address", () => {
    expect(
      validateTestRecipient("jaysahnan31@gmail.com", "jay@sahnan.co"),
    ).toEqual({ ok: true, to: "jaysahnan31@gmail.com" });
  });

  it("trims and lowercases", () => {
    expect(
      validateTestRecipient("  Jay31@GMAIL.com ", "jay@sahnan.co"),
    ).toEqual({ ok: true, to: "jay31@gmail.com" });
  });

  it("rejects the connected address regardless of case", () => {
    const result = validateTestRecipient("JAY@Sahnan.co", "jay@sahnan.co");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/different mailbox/i);
  });

  it("rejects a malformed address", () => {
    expect(validateTestRecipient("not-an-email", "jay@sahnan.co").ok).toBe(
      false,
    );
  });
});

describe("checkTestCooldown", () => {
  const now = new Date("2026-07-30T12:00:00Z");

  it("allows the first ever test", () => {
    expect(checkTestCooldown(null, now)).toEqual({ ok: true });
  });

  it("rejects at 59s and reports seconds remaining", () => {
    const last = new Date(now.getTime() - 59_000).toISOString();
    const result = checkTestCooldown(last, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryAfterSeconds).toBe(1);
  });

  it("allows at 61s", () => {
    const last = new Date(now.getTime() - 61_000).toISOString();
    expect(checkTestCooldown(last, now)).toEqual({ ok: true });
  });

  it("allows exactly at the boundary", () => {
    const last = new Date(now.getTime() - TEST_COOLDOWN_MS).toISOString();
    expect(checkTestCooldown(last, now)).toEqual({ ok: true });
  });
});

describe("matchTestReply", () => {
  const MSG_ID = "<test-1@sahnan.co>";
  const base = {
    inReplyTo: null,
    references: [],
    bodyText: "",
    subject: "",
    date: null,
    uid: null,
  };

  it("matches a threaded reply and returns envelope details", () => {
    const inbound = [
      {
        ...base,
        fromAddress: "jaysahnan31@gmail.com",
        inReplyTo: MSG_ID,
        subject: "Re: Signal test",
        date: new Date("2026-07-30T14:32:00Z"),
        uid: null,
      },
    ];

    expect(matchTestReply(inbound, MSG_ID, "jay@sahnan.co")).toEqual({
      status: "replied",
      fromAddress: "jaysahnan31@gmail.com",
      subject: "Re: Signal test",
      date: new Date("2026-07-30T14:32:00Z"),
      uid: null,
    });
  });

  it("reports a daemon message as bounced", () => {
    const inbound = [
      {
        ...base,
        fromAddress: "mailer-daemon@googlemail.com",
        bodyText: `original message id ${MSG_ID}`,
        subject: "Delivery Status Notification (Failure)",
      },
    ];

    expect(matchTestReply(inbound, MSG_ID, "jay@sahnan.co")?.status).toBe(
      "bounced",
    );
  });

  it("ignores unrelated mail", () => {
    const inbound = [
      { ...base, fromAddress: "someone@example.com", inReplyTo: "<other@x>" },
    ];
    expect(matchTestReply(inbound, MSG_ID, "jay@sahnan.co")).toBeNull();
  });

  it("ignores a reply from our own address (self-reply filter)", () => {
    const inbound = [
      { ...base, fromAddress: "jay@sahnan.co", inReplyTo: MSG_ID },
    ];
    expect(matchTestReply(inbound, MSG_ID, "jay@sahnan.co")).toBeNull();
  });
});

describe("extractReplyText", () => {
  // Exactly what Gmail returned for a real reply during live debugging.
  const REAL = `omg it works so cool

On Thu, 30 Jul 2026 at 22:48, <jay@sahnan.co> wrote:

> This is a test send from Signal. Reply to this email and Signal should
> detect your reply within a minute.
>
`;

  it("keeps only what the person typed", () => {
    expect(extractReplyText(REAL)).toBe("omg it works so cool");
  });

  it("drops quoted lines even without an attribution line", () => {
    expect(extractReplyText("thanks!\n> old thing\n> more old")).toBe(
      "thanks!",
    );
  });

  it("handles Outlook-style original message separators", () => {
    const raw = "sounds good\n\n-----Original Message-----\nFrom: someone";
    expect(extractReplyText(raw)).toBe("sounds good");
  });

  it("normalises CRLF and collapses blank runs", () => {
    expect(extractReplyText("a\r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
  });

  it("truncates long replies with an ellipsis", () => {
    const result = extractReplyText("x".repeat(REPLY_SNIPPET_MAX + 50));
    expect(result).toHaveLength(REPLY_SNIPPET_MAX + 1);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty string for a body that is entirely quoted", () => {
    expect(extractReplyText("> only quoted\n> lines here")).toBe("");
  });
});
