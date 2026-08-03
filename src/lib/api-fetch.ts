"use client";

import { toast } from "sonner";

interface ClerkWindow {
  Clerk?: { session?: { getToken: () => Promise<string | null> } };
}

/**
 * A freshly-minted Clerk session token, or null when signed out.
 *
 * `getToken()` returns the cached token and transparently refreshes it when it
 * is close to expiring, so calling this per request is the point — not waste.
 */
export async function getSessionToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;

  const token = await (
    window as unknown as ClerkWindow
  ).Clerk?.session?.getToken();

  return token ?? null;
}

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
 * Drop-in `fetch` for this app's own /api routes.
 *
 * Clerk's `__session` cookie is short-lived and stops refreshing while a tab is
 * backgrounded, so a cookie-only request from a long-open tab gets rejected by
 * `auth.protect()` before the route ever runs. Clerk accepts a Bearer token as
 * readily as the cookie, so attaching a fresh one keeps a stale tab working.
 *
 * A 401 that survives that is a genuinely dead session: surface it once, rather
 * than letting callers render it as "3 failed to send".
 *
 * Returns the `Response` unchanged, so `res.ok` / `res.json()` callers are
 * unaffected.
 */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getSessionToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) reportExpiredSession();

  return res;
}
