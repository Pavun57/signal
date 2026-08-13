"use client";

import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

/**
 * Browser Supabase client. The session lives in cookies (shared with the
 * server via @supabase/ssr), so every query runs as the signed-in user and
 * RLS scopes rows to them — no token wiring needed here.
 */
export const createClient = () =>
  createBrowserClient(supabaseUrl!, supabaseKey!);
