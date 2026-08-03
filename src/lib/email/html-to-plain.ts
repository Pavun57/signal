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
  return decodeEntities(
    blockToNewlines(html).replace(/<[^>]+>/g, ""),
  ).trim();
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
      const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
      const url = decodeEntities(href).trim();
      if (!url) return text;
      if (!text) return url;
      return text === url ? url : `${text} (${url})`;
    },
  );
  return decodeEntities(withLinks.replace(/<[^>]+>/g, "")).trim();
}
