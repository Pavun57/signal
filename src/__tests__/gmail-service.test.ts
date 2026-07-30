import { describe, expect, it } from "vitest";

import {
  classifyInboundMessage,
  getEffectiveDailyLimit,
} from "@/lib/services/gmail-service";

describe("classifyInboundMessage", () => {
  const pending = new Map([
    ["<sent-1@sahnan.co>", "email_row_1"],
    ["<sent-2@sahnan.co>", "email_row_2"],
  ]);

  it("matches a reply by In-Reply-To", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "prospect@example.com",
          inReplyTo: "<sent-1@sahnan.co>",
          references: [],
          bodyText: "",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toEqual({ status: "replied", sentEmailId: "email_row_1" });
  });

  it("matches a reply by References when In-Reply-To is absent", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "prospect@example.com",
          inReplyTo: null,
          references: ["<other@x>", "<sent-2@sahnan.co>"],
          bodyText: "",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toEqual({ status: "replied", sentEmailId: "email_row_2" });
  });

  it("classifies a mailer-daemon message referencing a sent id as a bounce", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "mailer-daemon@googlemail.com",
          inReplyTo: "<sent-1@sahnan.co>",
          references: [],
          bodyText: "Address not found",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toEqual({ status: "bounced", sentEmailId: "email_row_1" });
  });

  it("matches a daemon bounce by Message-ID appearing in the body", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          inReplyTo: null,
          references: [],
          bodyText: "The response was: 550 ... Message-ID: <sent-2@sahnan.co>",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toEqual({ status: "bounced", sentEmailId: "email_row_2" });
  });

  it("ignores our own messages and unrelated mail", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "jay@sahnan.co",
          inReplyTo: "<sent-1@sahnan.co>",
          references: [],
          bodyText: "",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toBeNull();
    expect(
      classifyInboundMessage(
        {
          fromAddress: "newsletter@stuff.com",
          inReplyTo: null,
          references: [],
          bodyText: "hello",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toBeNull();
  });

  it("is case-insensitive on our own address", () => {
    expect(
      classifyInboundMessage(
        {
          fromAddress: "JAY@SAHNAN.CO",
          inReplyTo: "<sent-1@sahnan.co>",
          references: [],
          bodyText: "",
        },
        pending,
        "jay@sahnan.co",
      ),
    ).toBeNull();
  });
});

describe("getEffectiveDailyLimit", () => {
  const cap = 30;
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86400_000).toISOString();

  it("ramps by mailbox age: 5 → 10 → 20 → cap", () => {
    expect(getEffectiveDailyLimit(daysAgo(0), cap)).toBe(5);
    expect(getEffectiveDailyLimit(daysAgo(2), cap)).toBe(5);
    expect(getEffectiveDailyLimit(daysAgo(3), cap)).toBe(10);
    expect(getEffectiveDailyLimit(daysAgo(7), cap)).toBe(20);
    expect(getEffectiveDailyLimit(daysAgo(14), cap)).toBe(cap);
  });

  it("never exceeds the user's configured cap", () => {
    expect(getEffectiveDailyLimit(daysAgo(5), 8)).toBe(8);
  });

  it("treats an unknown connect date as fully ramped", () => {
    expect(getEffectiveDailyLimit(null, cap)).toBe(cap);
  });
});
