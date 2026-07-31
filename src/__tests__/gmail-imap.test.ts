import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

/**
 * Regression test for the imapflow deadlock: issuing any IMAP command (like
 * download) while the fetch generator is live hangs forever, because the
 * FETCH doesn't complete until all rows are consumed and the nested command
 * queues behind it. fetchInboundSince must collect rows first and download
 * bounce bodies only after the fetch loop has fully drained.
 */

const state = vi.hoisted(() => ({
  order: [] as string[],
  searchQuery: null as { since?: Date } | null,
}));

vi.mock("imapflow", () => {
  class FakeImapFlow {
    async connect() {
      state.order.push("connect");
    }
    async getMailboxLock() {
      return { release: () => state.order.push("release") };
    }
    async *fetch(query: { since?: Date }) {
      state.searchQuery = query;
      state.order.push("fetch-start");
      yield {
        uid: 11,
        envelope: {
          from: [{ address: "mailer-daemon@googlemail.com" }],
          inReplyTo: "",
          subject: "Delivery Status Notification (Failure)",
          date: new Date("2026-07-30T14:30:00Z"),
        },
        headers: Buffer.from(""),
      };
      yield {
        uid: 12,
        envelope: {
          from: [{ address: "prospect@example.com" }],
          inReplyTo: "<sent-1@sahnan.co>",
          subject: "Re: Signal test",
          date: new Date("2026-07-30T14:32:00Z"),
        },
        headers: Buffer.from("References: <sent-1@sahnan.co>"),
      };
      state.order.push("fetch-end");
    }
    async download(uid: string) {
      state.order.push(`download-${uid}`);
      return {
        content: Readable.from([
          Buffer.from(
            "The response was: 550 ... Message-ID: <sent-2@sahnan.co>",
          ),
        ]),
      };
    }
    async logout() {
      state.order.push("logout");
    }
  }
  return { ImapFlow: FakeImapFlow };
});

import { fetchInboundSince } from "@/lib/services/gmail-service";

describe("fetchInboundSince", () => {
  beforeEach(() => {
    state.order.length = 0;
  });

  it("downloads bounce bodies only AFTER the fetch loop has drained", async () => {
    await fetchInboundSince(
      { address: "jay@sahnan.co", appPassword: "pw" },
      new Date(),
    );

    const fetchEnd = state.order.indexOf("fetch-end");
    const download = state.order.indexOf("download-11");
    expect(fetchEnd).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(fetchEnd);
    // Non-daemon messages are never downloaded.
    expect(state.order).not.toContain("download-12");
  });

  it("returns summaries with daemon bodies populated and lock released", async () => {
    const inbound = await fetchInboundSince(
      { address: "jay@sahnan.co", appPassword: "pw" },
      new Date(),
    );

    expect(inbound).toHaveLength(2);
    expect(inbound[0].bodyText).toContain("<sent-2@sahnan.co>");
    expect(inbound[1].bodyText).toBe("");
    expect(inbound[1].inReplyTo).toBe("<sent-1@sahnan.co>");
    expect(state.order).toContain("release");
    expect(state.order).toContain("logout");
  });

  it("carries envelope subject and date through to the summary", async () => {
    const inbound = await fetchInboundSince(
      { address: "jay@sahnan.co", appPassword: "pw" },
      new Date(),
    );

    expect(inbound[1].subject).toBe("Re: Signal test");
    expect(inbound[1].date).toEqual(new Date("2026-07-30T14:32:00Z"));
  });

  /**
   * Regression: IMAP SINCE is DATE-granular and the server compares it against
   * each message's internal date in the ACCOUNT's timezone, not UTC. Passing
   * the raw UTC timestamp means that for a US/Pacific account, every send
   * between 17:00 local and midnight searches a calendar day AHEAD of the
   * server's view and returns zero rows — replies sitting correctly threaded
   * in the INBOX are silently invisible. Verified live: a reply to a 05:48Z
   * send was unfindable until the window was widened.
   */
  it("widens the IMAP search window by a day to survive timezone skew", async () => {
    const sentAt = new Date("2026-07-31T05:48:26.000Z");
    await fetchInboundSince(
      { address: "jay@sahnan.co", appPassword: "pw" },
      sentAt,
    );

    const searched = state.searchQuery?.since;
    expect(searched).toBeInstanceOf(Date);
    expect(sentAt.getTime() - searched!.getTime()).toBe(86400_000);
    // The UTC calendar date must land strictly before the caller's, or the
    // date-granular SINCE can still exclude the very message we want.
    expect(searched!.getUTCDate()).toBeLessThan(sentAt.getUTCDate());
  });
});
