import { describe, expect, it } from "vitest";

import { htmlToPlain, plainToHtml } from "@/lib/email/html-to-plain";

describe("editor round-trip (htmlToPlain -> plainToHtml)", () => {
  it("escapes what htmlToPlain decoded, so the trip is symmetric", () => {
    // htmlToPlain decodes entities into the textarea; plainToHtml used to
    // re-serialise without encoding, so "&lt;10ms" came back as a raw
    // "<10ms" that mail clients parse as a tag open and swallow.
    const original = "<p>we cut latency to &lt;10ms &amp; kept costs flat</p>";
    const text = htmlToPlain(original);
    expect(text).toBe("we cut latency to <10ms & kept costs flat");

    const back = plainToHtml(text);
    expect(back).toBe(
      "<p>we cut latency to &lt;10ms &amp; kept costs flat</p>",
    );
    // And it survives a second pass unchanged.
    expect(plainToHtml(htmlToPlain(back))).toBe(back);
  });

  it("escapes characters the user types directly", () => {
    expect(plainToHtml("a < b & c > d")).toBe("<p>a &lt; b &amp; c &gt; d</p>");
  });

  it("keeps paragraph and line-break structure", () => {
    expect(plainToHtml("one\ntwo\n\nthree")).toBe(
      "<p>one<br>two</p><p>three</p>",
    );
  });
});
