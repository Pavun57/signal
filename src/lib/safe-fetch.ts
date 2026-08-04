import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound HTTP for URLs the product did not choose.
 *
 * Signal fetches company websites, careers pages, sitemaps and whatever a
 * scraped page links to. Those URLs arrive from CSV imports, from the agent,
 * from Exa results and from the HTML of pages we just fetched — none of it
 * ours. Signal is also explicitly self-hosted, so "the network this runs on"
 * is the operator's own: `http://169.254.169.254/`, `http://127.0.0.1:54321`
 * and `http://10.0.0.5/admin` are all real destinations, and the fetched body
 * comes back in an API response and is persisted into enrichment_data.
 *
 * Three things have to hold together, and any one alone is not enough:
 *
 *  1. The scheme must be http(s). `file:`, `gopher:` and friends are not
 *     transport we ever want.
 *  2. Every address the hostname resolves to must be publicly routable. A name
 *     that resolves to a private address is the standard bypass, and a name
 *     with several A records only needs one bad one.
 *  3. Redirects must be followed by hand, revalidating each hop. A host that
 *     passes the check and then 302s to the metadata service defeats a check
 *     performed only on the URL the caller passed in.
 *
 * The deadline also has to outlive the headers. `fetch` resolves as soon as
 * headers arrive, so a timer cleared at that point leaves the body unbounded:
 * a server that returns 200 and then dribbles one byte per second holds the
 * invocation until the platform kills it. `AbortSignal.timeout` stays armed
 * through body consumption, which is why it is used here instead.
 */

/** Raised when a URL is refused. Distinct so callers can report it honestly. */
export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BlockedUrlError";
  }
}

/**
 * Hostname -> addresses. Injectable so tests can describe a hostile DNS answer
 * without touching the network, and so the guard can be exercised offline.
 */
export type HostResolver = (host: string) => Promise<string[]>;

const realResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

export interface SafeFetchOptions {
  /** Whole-operation deadline, headers *and* body. */
  timeoutMs?: number;
  /** Redirect hops to follow, each revalidated. */
  maxRedirects?: number;
  /** Hard ceiling on the body, in bytes. */
  maxBytes?: number;
  /** Override DNS. Tests only; production uses the real resolver. */
  resolveHost?: HostResolver;
}

const DEFAULTS = {
  timeoutMs: 30_000,
  maxRedirects: 3,
  maxBytes: 5_000_000,
} satisfies Omit<Required<SafeFetchOptions>, "resolveHost">;

function ipv4IsPublic(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a, b] = p;
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 192 && b === 0) return false; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast + reserved
  return true;
}

function ipv6IsPublic(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // ::ffff:127.0.0.1 and friends are IPv4 wearing a hat.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPublic(mapped[1]);

  if (addr === "::" || addr === "::1") return false;
  if (/^f[cd]/.test(addr)) return false; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(addr)) return false; // fe80::/10 link-local
  if (/^ff/.test(addr)) return false; // multicast
  return true;
}

/** Is this literal address one we are willing to talk to? */
export function addressIsPublic(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4IsPublic(ip);
  if (kind === 6) return ipv6IsPublic(ip);
  return false;
}

/**
 * Parses and vets a URL, resolving the hostname so a public name pointing at a
 * private address is refused. Throws BlockedUrlError with a reason worth
 * showing a user.
 */
export async function assertPublicUrl(
  raw: string,
  resolveHost: HostResolver = realResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`"${raw}" is not a valid URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(
      `${url.protocol} is not a supported scheme; only http and https are fetched.`,
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(host)) {
    if (!addressIsPublic(host)) {
      throw new BlockedUrlError(
        `${host} is not a publicly routable address, so it will not be fetched.`,
      );
    }
    return url;
  }

  // A single-label host ("localhost", "supabase-kong") is only meaningful on
  // an internal network.
  if (!host.includes(".")) {
    throw new BlockedUrlError(
      `"${host}" is not a public hostname, so it will not be fetched.`,
    );
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new BlockedUrlError(`"${host}" could not be resolved.`);
  }

  if (addresses.length === 0) {
    throw new BlockedUrlError(`"${host}" resolved to no addresses.`);
  }
  // Every address, not just the first: one private A record is enough.
  for (const address of addresses) {
    if (!addressIsPublic(address)) {
      throw new BlockedUrlError(
        `"${host}" resolves to ${address}, which is not publicly routable.`,
      );
    }
  }

  return url;
}

/**
 * Reads a response body with a hard byte ceiling, so a huge or endless body
 * cannot exhaust memory. Returns what arrived up to the cap.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number = DEFAULTS.maxBytes,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new BlockedUrlError(
      `Response is ${declared} bytes, over the ${maxBytes} byte limit.`,
    );
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(decoder.decode(value, { stream: true }));
        break; // Keep what we have; the caller wanted content, not all of it.
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return chunks.join("");
}

/**
 * `fetch` for a URL we did not choose: scheme and address vetted, redirects
 * followed by hand with every hop revalidated, and a deadline that covers the
 * body rather than stopping at the headers.
 *
 * The response is returned with its body unread, so callers can stream it —
 * pair it with `readBodyCapped` rather than `res.text()`.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const { timeoutMs, maxRedirects } = { ...DEFAULTS, ...options };
  const resolveHost = options.resolveHost ?? realResolver;

  let target = await assertPublicUrl(rawUrl, resolveHost);
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(target, {
      ...init,
      signal,
      redirect: "manual",
    });

    const location = response.headers.get("location");
    const isRedirect =
      response.status >= 300 && response.status < 400 && location;

    if (!isRedirect) return response;

    if (hop === maxRedirects) {
      throw new BlockedUrlError(
        `Too many redirects (more than ${maxRedirects}) from ${rawUrl}.`,
      );
    }

    // Resolved against the current URL so a relative Location works, then
    // vetted again: passing the first check buys the destination nothing.
    response.body?.cancel().catch(() => {});
    target = await assertPublicUrl(
      new URL(location, target).toString(),
      resolveHost,
    );
  }

  throw new BlockedUrlError(
    `Could not resolve ${rawUrl} within the hop limit.`,
  );
}
