/**
 * Best-effort mapping from free-text location strings (enrichment data, org
 * HQ) to an IANA timezone, for recipient-local send windows. Deliberately
 * curated rather than exhaustive: a wrong-but-confident zone is worse than
 * falling back to the sender's window, so anything ambiguous resolves to
 * null. Multi-timezone countries (US, Canada, Australia, Brazil, Mexico,
 * Russia) only resolve through a city or US state match.
 */

/** City / state / country keywords, matched longest-first against the hint. */
export const LOCATION_TIMEZONES: Record<string, string> = {
  // Cities: North America
  "san francisco": "America/Los_Angeles",
  "los angeles": "America/Los_Angeles",
  "san diego": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  portland: "America/Los_Angeles",
  vancouver: "America/Vancouver",
  phoenix: "America/Phoenix",
  denver: "America/Denver",
  "salt lake city": "America/Denver",
  austin: "America/Chicago",
  dallas: "America/Chicago",
  houston: "America/Chicago",
  chicago: "America/Chicago",
  minneapolis: "America/Chicago",
  "new york": "America/New_York",
  nyc: "America/New_York",
  boston: "America/New_York",
  philadelphia: "America/New_York",
  "washington, d": "America/New_York",
  atlanta: "America/New_York",
  miami: "America/New_York",
  toronto: "America/Toronto",
  montreal: "America/Toronto",
  "mexico city": "America/Mexico_City",
  // Cities: Europe / Middle East / Africa
  london: "Europe/London",
  edinburgh: "Europe/London",
  manchester: "Europe/London",
  dublin: "Europe/Dublin",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  munich: "Europe/Berlin",
  hamburg: "Europe/Berlin",
  frankfurt: "Europe/Berlin",
  amsterdam: "Europe/Amsterdam",
  brussels: "Europe/Brussels",
  zurich: "Europe/Zurich",
  geneva: "Europe/Zurich",
  madrid: "Europe/Madrid",
  barcelona: "Europe/Madrid",
  lisbon: "Europe/Lisbon",
  milan: "Europe/Rome",
  rome: "Europe/Rome",
  vienna: "Europe/Vienna",
  prague: "Europe/Prague",
  warsaw: "Europe/Warsaw",
  stockholm: "Europe/Stockholm",
  copenhagen: "Europe/Copenhagen",
  oslo: "Europe/Oslo",
  helsinki: "Europe/Helsinki",
  athens: "Europe/Athens",
  bucharest: "Europe/Bucharest",
  budapest: "Europe/Budapest",
  kyiv: "Europe/Kyiv",
  istanbul: "Europe/Istanbul",
  "tel aviv": "Asia/Jerusalem",
  dubai: "Asia/Dubai",
  cairo: "Africa/Cairo",
  lagos: "Africa/Lagos",
  nairobi: "Africa/Nairobi",
  "cape town": "Africa/Johannesburg",
  johannesburg: "Africa/Johannesburg",
  // Cities: Asia-Pacific / South America
  bangalore: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  "new delhi": "Asia/Kolkata",
  hyderabad: "Asia/Kolkata",
  singapore: "Asia/Singapore",
  "hong kong": "Asia/Hong_Kong",
  shanghai: "Asia/Shanghai",
  beijing: "Asia/Shanghai",
  shenzhen: "Asia/Shanghai",
  taipei: "Asia/Taipei",
  seoul: "Asia/Seoul",
  tokyo: "Asia/Tokyo",
  osaka: "Asia/Tokyo",
  jakarta: "Asia/Jakarta",
  manila: "Asia/Manila",
  sydney: "Australia/Sydney",
  melbourne: "Australia/Melbourne",
  brisbane: "Australia/Brisbane",
  auckland: "Pacific/Auckland",
  wellington: "Pacific/Auckland",
  "sao paulo": "America/Sao_Paulo",
  "são paulo": "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires",
  bogota: "America/Bogota",
  bogotá: "America/Bogota",
  santiago: "America/Santiago",
  lima: "America/Lima",
  // Countries (single-timezone, or one dominant business zone)
  "united kingdom": "Europe/London",
  england: "Europe/London",
  scotland: "Europe/London",
  ireland: "Europe/Dublin",
  france: "Europe/Paris",
  germany: "Europe/Berlin",
  netherlands: "Europe/Amsterdam",
  belgium: "Europe/Brussels",
  switzerland: "Europe/Zurich",
  spain: "Europe/Madrid",
  portugal: "Europe/Lisbon",
  italy: "Europe/Rome",
  austria: "Europe/Vienna",
  "czech republic": "Europe/Prague",
  czechia: "Europe/Prague",
  poland: "Europe/Warsaw",
  sweden: "Europe/Stockholm",
  denmark: "Europe/Copenhagen",
  norway: "Europe/Oslo",
  finland: "Europe/Helsinki",
  greece: "Europe/Athens",
  romania: "Europe/Bucharest",
  hungary: "Europe/Budapest",
  ukraine: "Europe/Kyiv",
  estonia: "Europe/Tallinn",
  latvia: "Europe/Riga",
  lithuania: "Europe/Vilnius",
  bulgaria: "Europe/Sofia",
  croatia: "Europe/Zagreb",
  serbia: "Europe/Belgrade",
  slovakia: "Europe/Bratislava",
  slovenia: "Europe/Ljubljana",
  turkey: "Europe/Istanbul",
  israel: "Asia/Jerusalem",
  "united arab emirates": "Asia/Dubai",
  "saudi arabia": "Asia/Riyadh",
  egypt: "Africa/Cairo",
  nigeria: "Africa/Lagos",
  kenya: "Africa/Nairobi",
  "south africa": "Africa/Johannesburg",
  india: "Asia/Kolkata",
  china: "Asia/Shanghai",
  taiwan: "Asia/Taipei",
  "south korea": "Asia/Seoul",
  japan: "Asia/Tokyo",
  philippines: "Asia/Manila",
  vietnam: "Asia/Ho_Chi_Minh",
  thailand: "Asia/Bangkok",
  "new zealand": "Pacific/Auckland",
  argentina: "America/Argentina/Buenos_Aires",
  colombia: "America/Bogota",
  chile: "America/Santiago",
  peru: "America/Lima",
};

/** US states → representative zone; matched as ", XX" or the full name. */
const US_STATE_TIMEZONES: Record<string, string> = {
  ca: "America/Los_Angeles",
  wa: "America/Los_Angeles",
  or: "America/Los_Angeles",
  nv: "America/Los_Angeles",
  az: "America/Phoenix",
  co: "America/Denver",
  ut: "America/Denver",
  nm: "America/Denver",
  mt: "America/Denver",
  wy: "America/Denver",
  id: "America/Denver",
  tx: "America/Chicago",
  il: "America/Chicago",
  mn: "America/Chicago",
  wi: "America/Chicago",
  mo: "America/Chicago",
  ia: "America/Chicago",
  ks: "America/Chicago",
  ne: "America/Chicago",
  ok: "America/Chicago",
  ar: "America/Chicago",
  la: "America/Chicago",
  ms: "America/Chicago",
  al: "America/Chicago",
  tn: "America/Chicago",
  ny: "America/New_York",
  ma: "America/New_York",
  pa: "America/New_York",
  fl: "America/New_York",
  ga: "America/New_York",
  nc: "America/New_York",
  sc: "America/New_York",
  va: "America/New_York",
  md: "America/New_York",
  nj: "America/New_York",
  ct: "America/New_York",
  ri: "America/New_York",
  nh: "America/New_York",
  vt: "America/New_York",
  me: "America/New_York",
  oh: "America/New_York",
  mi: "America/New_York",
  in: "America/New_York",
  ky: "America/New_York",
  wv: "America/New_York",
  de: "America/New_York",
  dc: "America/New_York",
  hi: "Pacific/Honolulu",
  ak: "America/Anchorage",
};

const KEYWORDS_LONGEST_FIRST = Object.keys(LOCATION_TIMEZONES).sort(
  (a, b) => b.length - a.length,
);

function resolveOne(hint: string): string | null {
  const text = hint.toLowerCase();

  for (const keyword of KEYWORDS_LONGEST_FIRST) {
    const idx = text.indexOf(keyword);
    if (idx === -1) continue;
    // Word-boundary check so "rome" doesn't match inside "Jerome".
    const before = idx === 0 ? "" : text[idx - 1];
    const after =
      idx + keyword.length >= text.length ? "" : text[idx + keyword.length];
    if (/[a-z]/.test(before) || /[a-z]/.test(after)) continue;
    return LOCATION_TIMEZONES[keyword];
  }

  // ", CA"-style US state codes. Only after a comma: bare two-letter pairs
  // ("in", "or", "me", "la"...) are ordinary words far too often.
  const stateMatch = /,\s*([a-z]{2})(?![a-z])/.exec(text);
  if (stateMatch && US_STATE_TIMEZONES[stateMatch[1]]) {
    return US_STATE_TIMEZONES[stateMatch[1]];
  }

  return null;
}

/**
 * Resolve the first location hint that maps to a timezone. Returns null when
 * nothing resolves; callers fall back to the sender's window rather than
 * guessing.
 */
export function resolveTimezoneFromLocation(
  ...hints: Array<string | null | undefined>
): string | null {
  for (const hint of hints) {
    if (!hint || typeof hint !== "string") continue;
    const resolved = resolveOne(hint);
    if (resolved) return resolved;
  }
  return null;
}
