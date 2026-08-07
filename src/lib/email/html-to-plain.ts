/**
 * Turning our own email HTML back into text.
 *
 * Two functions on purpose, because the two callers want different things and
 * conflating them silently destroys links.
 *
 * `htmlToPlain` is the editor's half of a round-trip: the review page renders a
 * draft into a textarea and re-serialises it with plainToHtml on save. It must
 * stay lossy in exactly the way it always has been, because whatever it emits
 * is what the user then edits and saves back.
 *
 * `htmlToDisplayText` is for read-only surfaces. It keeps a link's URL, which
 * the editor's version throws away.
 */

const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/g, " "],
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
];

function decodeEntities(s: string): string {
  return ENTITIES.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

function blockToNewlines(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/p>/gi, "");
}

/**
 * Removes tags, repeating until the string stops changing.
 *
 * Being straight about what this is and is not:
 *
 * NOT a sanitizer, and nothing here may be used as one. These outputs become
 * React text children, which React escapes, so markup surviving would render
 * as visible text rather than an element. If a caller ever needs real HTML,
 * the answer is a sandboxed iframe, not this.
 *
 * The loop is defence in depth, not a fix for a live hole. CodeQL flags a
 * single-pass tag strip (js/incomplete-multi-character-sanitization) because
 * removing an inner tag can reassemble an outer one. For THIS pattern that
 * turns out not to happen -- `<scr<script>ipt>` becomes `ipt>` in one pass and
 * a second pass changes nothing, which I checked rather than assumed. The loop
 * earns its place by making that property hold for whatever the pattern
 * becomes later, instead of resting on a hand-check of today's regex.
 *
 * Terminates because any pass that changes the string strictly shortens it.
 */
function stripTags(input: string): string {
  let out = input;
  for (;;) {
    const next = out.replace(/<[^>]+>/g, "");
    if (next === out) return out;
    out = next;
  }
}

/**
 * Lossy conversion used by the draft editor's round-trip.
 *
 * Anchors collapse to their text and the href is discarded. That is wrong for
 * display but right here: the output goes into a textarea, and preserving the
 * URL inline would mean plainToHtml re-serialised it as literal text on save,
 * permanently destroying the link.
 *
 * Moved out of outreach/review/page.tsx unchanged so both surfaces share one
 * implementation.
 */
export function htmlToPlain(html: string): string {
  if (!html) return "";
  return decodeEntities(stripTags(blockToNewlines(html))).trim();
}

/**
 * The editor's serialiser: the other half of htmlToPlain's round-trip.
 *
 * Escapes &, < and > before wrapping, because htmlToPlain DECODES entities
 * on the way into the textarea: without the matching encode on the way back
 * the round trip was asymmetric, and a body containing "&lt;10ms" came back
 * as a raw "<10ms" that mail clients parse as a tag open and swallow.
 *
 * Moved out of outreach/review/page.tsx so it can be tested against
 * htmlToPlain directly.
 */
export function plainToHtml(text: string): string {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const paragraphs = escaped
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

/**
 * Read-only conversion that keeps link targets.
 *
 * The composer is allowed to emit anchors (skill.ts permits <p>, <br> and <a>),
 * so stripping tags blindly loses the URL entirely and a reader cannot tell
 * where "book a time" pointed. Renders `<a href="X">Y</a>` as `Y (X)`, and as
 * plain `X` when the text already is the URL, so a bare link does not come out
 * as the useless `https://x (https://x)`.
 *
 * Never use this for the editor: `Y (X)` round-trips back through plainToHtml
 * as literal text, which would destroy the anchor on the next save.
 */
export function htmlToDisplayText(html: string): string {
  if (!html) return "";
  const withLinks = blockToNewlines(html).replace(
    /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, inner: string) => {
      const text = decodeEntities(stripTags(inner)).trim();
      const url = decodeEntities(href).trim();
      if (!url) return text;
      if (!text) return url;
      return text === url ? url : `${text} (${url})`;
    },
  );
  return decodeEntities(stripTags(withLinks)).trim();
}
