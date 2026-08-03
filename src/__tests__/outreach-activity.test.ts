import { describe, expect, it } from "vitest";

import {
  classifyPending,
  classifySent,
  gmailSearchUrl,
  replySnippet,
} from "@/lib/outreach/activity";
import { htmlToDisplayText, htmlToPlain } from "@/lib/email/html-to-plain";

describe("gmailSearchUrl", () => {
  it("builds an rfc822msgid search for the sending mailbox", () => {
    const url = gmailSearchUrl("<abc123@mail.gmail.com>", "jay@sahnan.co");
    expect(url).toBe(
      "https://mail.google.com/mail/u/?authuser=jay%40sahnan.co#search/rfc822msgid%3Aabc123%40mail.gmail.com",
    );
  });

  it("strips the angle brackets Gmail handles inconsistently", () => {
    expect(gmailSearchUrl("<a@b>", null)).toContain("rfc822msgid%3Aa%40b");
    expect(gmailSearchUrl("<a@b>", null)).not.toContain("%3C");
  });

  it("encodes characters nodemailer can put in an id", () => {
    // A raw + or # in a URL fragment would truncate or mis-route the search.
    const url = gmailSearchUrl("<a+b#c@d>", null)!;
    expect(url).toContain("%2B");
    expect(url).toContain("%23");
  });

  it("returns null without a Message-ID rather than guessing", () => {
    // A subject search on a cold email is a shotgun. Opening the wrong thread
    // is worse than opening nothing.
    expect(gmailSearchUrl(null, "jay@sahnan.co")).toBeNull();
    expect(gmailSearchUrl("  ", "jay@sahnan.co")).toBeNull();
  });

  it("omits authuser when the sending address is unknown", () => {
    expect(gmailSearchUrl("<a@b>", null)).toBe(
      "https://mail.google.com/mail/u/#search/rfc822msgid%3Aa%40b",
    );
  });
});

describe("classifySent", () => {
  it("maps the three statuses that are actually written", () => {
    expect(classifySent("replied")).toBe("replied");
    expect(classifySent("bounced")).toBe("bounced");
    expect(classifySent("sent")).toBe("sent");
  });

  it("treats legacy values as plain sent", () => {
    // 'opened' and 'delivered' are in the CHECK constraint but nothing has
    // ever written them: Signal sends no tracking pixel.
    expect(classifySent("opened")).toBe("sent");
    expect(classifySent("delivered")).toBe("sent");
  });
});

describe("classifyPending", () => {
  const base = { status: "draft", last_error_kind: null, next_send_at: null };

  it("keeps deferred separate from failed", () => {
    // Hitting the daily cap is routine and by far the most common non-send.
    // Showing it as a failure would bury the kinds that need attention.
    expect(classifyPending({ ...base, last_error_kind: "deferred" })).toBe(
      "deferred",
    );
    expect(classifyPending({ ...base, last_error_kind: "failed" })).toBe(
      "failed",
    );
    expect(classifyPending({ ...base, last_error_kind: "blocked" })).toBe(
      "blocked",
    );
  });

  it("prefers the error over the waiting state", () => {
    // "Why it did not send" beats "it is waiting" when both are true.
    expect(
      classifyPending({
        status: "queued",
        last_error_kind: "blocked",
        next_send_at: "2026-08-04T09:00:00Z",
      }),
    ).toBe("blocked");
  });

  it("distinguishes scheduled from queued", () => {
    expect(
      classifyPending({ ...base, next_send_at: "2026-08-04T09:00:00Z" }),
    ).toBe("scheduled");
    expect(classifyPending({ ...base, status: "queued" })).toBe("queued");
    expect(classifyPending(base)).toBe("queued");
  });
});

describe("replySnippet", () => {
  it("collapses whitespace onto one line", () => {
    expect(replySnippet("Sounds good.\n\nNext week works.")).toBe(
      "Sounds good. Next week works.",
    );
  });

  it("distinguishes no body from an empty one", () => {
    expect(replySnippet(null)).toBeNull();
    expect(replySnippet("   ")).toBeNull();
  });

  it("truncates long replies", () => {
    const snippet = replySnippet("x".repeat(500))!;
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThan(200);
  });
});

describe("html to text", () => {
  const body =
    '<p>Hi Dana,</p><p>Worth a look: <a href="https://arbor.dev/demo">book a time</a></p>';

  it("keeps the URL on read-only surfaces", () => {
    // The composer is allowed to emit anchors, so stripping tags blindly loses
    // where the link pointed and the reader cannot tell what was sent.
    expect(htmlToDisplayText(body)).toBe(
      "Hi Dana,\n\nWorth a look: book a time (https://arbor.dev/demo)",
    );
  });

  it("still drops the URL in the editor's lossy variant", () => {
    // This one feeds a textarea that plainToHtml re-serialises on save, so
    // preserving the URL inline would write it back as literal text and
    // destroy the anchor.
    expect(htmlToPlain(body)).toBe("Hi Dana,\n\nWorth a look: book a time");
  });

  it("does not double up a bare link", () => {
    expect(
      htmlToDisplayText('<p><a href="https://a.co">https://a.co</a></p>'),
    ).toBe("https://a.co");
  });

  it("falls back to the URL when the anchor has no text", () => {
    expect(htmlToDisplayText('<p><a href="https://a.co"></a></p>')).toBe(
      "https://a.co",
    );
  });

  it("decodes entities in both variants", () => {
    expect(htmlToDisplayText("<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry");
    expect(htmlToPlain("<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry");
  });

  it("turns paragraph and break structure into newlines", () => {
    expect(htmlToDisplayText("<p>a<br>b</p><p>c</p>")).toBe("a\nb\n\nc");
  });
});
