"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getSessionToken } from "@/lib/api-fetch";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

/**
 * Browser Supabase client that forwards the Clerk session token as a Bearer
 * header on every request. Supabase's third-party auth integration validates
 * the JWT and exposes the Clerk user id as `auth.jwt() ->> 'sub'` for RLS.
 *
 * `getSessionToken` waits for Clerk's async bootstrap before reading the
 * token — the wait is load-bearing here. Pages query in mount effects, which
 * on a hard load race the Clerk script; a query sent early goes out
 * anonymously, RLS matches nothing, and the page renders empty with no error.
 */
export const createClient = () =>
  createBrowserClient(supabaseUrl!, supabaseKey!, {
    global: {
      fetch: async (input, init = {}) => {
        const token = await getSessionToken();
        const headers = new Headers(init.headers);
        if (token) headers.set("Authorization", `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      },
    },
  });
