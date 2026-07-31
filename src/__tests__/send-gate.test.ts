import { describe, it, expect } from "vitest";

import {
  canSendTo,
  AFFILIATION_WEIGHT,
  type SendCandidate,
} from "@/lib/services/affiliation";

/**
 * Nothing checked any of this before: the send path asked only whether the
 * address field was non-empty, so a blind {first}.{last}@domain guess written
 * at confidence 0.2 was treated exactly like an address the user typed in.
 *
 * The two halves fail differently and both matter — a bad address bounces and
 * costs sender reputation, a bad affiliation sends a personalised pitch about
 * the wrong company to a real person.
 */

const base: SendCandidate = {
  work_email: "jane.doe@acme.com",
  work_email_source: "pattern_derived",
  work_email_verification: "deliverable",
  affiliation_confidence: AFFILIATION_WEIGHT.team_page,
  affiliation_source: "team_page",
};

const p = (over: Partial<SendCandidate> = {}): SendCandidate => ({
  ...base,
  ...over,
});

describe("canSendTo", () => {
  it("allows a verified address at a confirmed employer", () => {
    expect(canSendTo(p())).toEqual({ ok: true });
  });

  it("blocks a contact with no address", () => {
    const result = canSendTo(p({ work_email: null }));
    expect(result.ok).toBe(false);
  });

  it("blocks an unverified pattern guess", () => {
    // The exact row the old code would have emailed.
    const result = canSendTo(
      p({
        work_email_verification: "unchecked",
        work_email_source: "pattern_derived",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/never been verified/i);
  });

  it("blocks a catch-all address", () => {
    const result = canSendTo(p({ work_email_verification: "risky" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("risky");
  });

  it("trusts an address the user typed, without a verifier", () => {
    // A human is better evidence than any API, and self-hosted instances may
    // have no provider configured at all.
    expect(
      canSendTo(
        p({
          work_email_source: "user_entered",
          work_email_verification: "unchecked",
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("trusts an address a previous send was accepted for", () => {
    expect(
      canSendTo(
        p({
          work_email_source: "send_confirmed",
          work_email_verification: "unchecked",
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("blocks a verified address at an unconfirmed employer", () => {
    // A real mailbox is not permission to pitch them about a company they may
    // not work for.
    const result = canSendTo(
      p({
        affiliation_source: "search_stamp",
        affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not confirmed to work/i);
  });

  it("blocks legacy rows that carry no affiliation evidence at all", () => {
    const result = canSendTo(
      p({ affiliation_source: null, affiliation_confidence: null }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no evidence/i);
  });

  it("allows an LLM-verified affiliation — exactly at the threshold", () => {
    expect(
      canSendTo(
        p({
          affiliation_source: "llm_verified",
          affiliation_confidence: AFFILIATION_WEIGHT.llm_verified,
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("blocks a bounced address even though a send once confirmed it", () => {
    // recordBounce marks the address undeliverable. Without that, canSendTo
    // trusts send_confirmed — which every sent address carries by definition —
    // so a hard-bounced mailbox stayed sendable for the next campaign.
    const result = canSendTo(
      p({
        work_email_source: "send_confirmed",
        work_email_verification: "undeliverable",
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("always explains the blockage rather than failing silently", () => {
    for (const person of [
      p({ work_email: null }),
      p({ work_email_verification: "unchecked" }),
      p({ affiliation_confidence: 0, affiliation_source: null }),
    ]) {
      const result = canSendTo(person);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(10);
    }
  });
});
