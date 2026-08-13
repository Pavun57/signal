"use client";

import { toast } from "sonner";

// Several calls can fail together (e.g. Send All fires one request per draft).
// One toast for the burst, not one per request.
const TOAST_COOLDOWN_MS = 10_000;
let lastExpiryToast = 0;

function reportExpiredSession() {
  const now = Date.now();
  if (now - lastExpiryToast < TOAST_COOLDOWN_MS) return;
  lastExpiryToast = now;

  toast.error("Your session expired", {
    description: "Sign in again to continue. Nothing was lost.",
    action: {
      label: "Sign in",
      onClick: () => {
        window.location.href = "/login";
      },
    },
  });
}

/**
 * Drop-in `fetch` for this app's own /api routes. Auth rides the Supabase
 * session cookie, so there's no header to attach — this wrapper exists to
 * normalize auth failures:
 *
 * - The proxy answers an unauthenticated /api request with a JSON 401; any
 *   redirect that lands outside /api (e.g. an HTML error page from a
 *   misconfigured reverse proxy) is re-reported as the 401 it really is,
 *   because fetch follows redirects and the caller would try to parse the
 *   HTML as JSON (`Unexpected token '<', "<!DOCTYPE"`).
 * - A 401 means a genuinely dead session: surface it once, rather than
 *   letting callers render it as "3 failed to send".
 *
 * Returns the `Response` unchanged, so `res.ok` / `res.json()` callers are
 * unaffected.
 */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(input, init);

  if (res.redirected && !new URL(res.url).pathname.startsWith("/api/")) {
    reportExpiredSession();
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (res.status === 401) reportExpiredSession();

  return res;
}
