import { Client, Receiver } from "@upstash/qstash";

let _client: Client | null = null;

export function getQStashClient(): Client {
  if (!_client) {
    const token = process.env.QSTASH_TOKEN;
    if (!token) throw new Error("QSTASH_TOKEN is required");
    _client = new Client({ token });
  }
  return _client;
}

/**
 * Extracts the `sub` claim (the signed destination URL) from a QStash
 * signature JWT without trusting it — authenticity is established by
 * receiver.verify first; this only exists to bind the signature to a route.
 */
function signedUrlFromSignature(signature: string): string | null {
  try {
    const payload = signature.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Verify QStash signature on incoming requests.
 * Returns the parsed body if valid (null for empty bodies — schedules created
 * in the Upstash console send none), throws if invalid.
 *
 * The signature is additionally bound to the request's *path*: QStash signs
 * the destination URL into the JWT `sub`, and without this check a signed
 * request captured for one public route could be replayed against any other.
 * Only the pathname is compared — hosts legitimately differ across Vercel
 * aliases and proxies.
 */
export async function verifyQStashSignature<T = unknown>(
  request: Request,
): Promise<T | null> {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentKey || !nextKey) {
    throw new Error(
      "QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY are required",
    );
  }

  const receiver = new Receiver({
    currentSigningKey: currentKey,
    nextSigningKey: nextKey,
  });

  const body = await request.text();
  const signature = request.headers.get("upstash-signature");

  if (!signature) {
    throw new Error("Missing upstash-signature header");
  }

  const isValid = await receiver.verify({
    signature,
    body,
  });

  if (!isValid) {
    throw new Error("Invalid QStash signature");
  }

  const signedUrl = signedUrlFromSignature(signature);
  if (signedUrl) {
    const signedPath = new URL(signedUrl).pathname;
    const requestPath = new URL(request.url).pathname;
    if (signedPath !== requestPath) {
      throw new Error(
        `QStash signature was issued for a different route (${signedPath})`,
      );
    }
  }

  if (!body.trim()) return null;
  return JSON.parse(body) as T;
}

/**
 * Get the base URL for QStash callbacks.
 * Uses VERCEL_URL in production, localhost in dev.
 */
export function getBaseUrl(): string {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}
