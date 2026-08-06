"use client";

import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

interface ClerkWindow {
  Clerk?: {
    loaded?: boolean;
    session?: { getToken: () => Promise<string | null> };
  };
}

/**
 * Waits for the Clerk script to finish initializing, then returns the session
 * token (null when signed out).
 *
 * The wait is load-bearing: pages fetch in mount effects, which on a hard
 * load race Clerk's async bootstrap. Reading the token too early sends the
 * request anonymously, RLS matches nothing, and the page renders empty with
 * no error. Bounded so a broken Clerk script degrades to today's behavior
 * (anonymous request) instead of hanging every query forever.
 */
async function getClerkToken(): Promise<string | null> {
  const w = window as unknown as ClerkWindow;
  const deadline = Date.now() + 10_000;
  while (!w.Clerk?.loaded && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await w.Clerk?.session?.getToken()) ?? null;
}

/**
 * Browser Supabase client that forwards the Clerk session token as a Bearer
 * header on every request. Supabase's third-party auth integration validates
 * the JWT and exposes the Clerk user id as `auth.jwt() ->> 'sub'` for RLS.
 *
 * Reads the token from `window.Clerk.session` (initialized by ClerkProvider)
 * so callers don't need a hook context — works inside callbacks, effects,
 * imperative service functions.
 */
export const createClient = () =>
  createBrowserClient(supabaseUrl!, supabaseKey!, {
    global: {
      fetch: async (input, init = {}) => {
        const token =
          typeof window !== "undefined" ? await getClerkToken() : null;
        const headers = new Headers(init.headers);
        if (token) headers.set("Authorization", `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      },
    },
  });
