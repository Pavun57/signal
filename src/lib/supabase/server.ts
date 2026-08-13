import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

/**
 * Server-side Supabase client bound to the caller's auth session.
 *
 * Auth is Supabase's own: the browser signs in with email/password, @supabase/ssr
 * stores the session in cookies, and this client attaches the session's access
 * token to every PostgREST call. The token carries `role: authenticated` and
 * `sub: <user uuid>` natively, so the RLS policies (which read
 * auth.jwt()->>'sub' via requesting_user_id()) work with no third-party
 * provider to configure.
 *
 * Token refresh is handled by the proxy middleware (proxy.ts), which re-mints
 * the cookie on each request — so long-running routes never hold an expired
 * token: supabase-js reads the latest session from the cookie store per call.
 */
export const createClient = async () => {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // proxy refreshes sessions on every request, so the session this
          // write would have persisted is already fresh — safe to skip.
        }
      },
    },
  });
};

/**
 * Returns the Supabase client and current user for route handlers.
 * Returns null if not authenticated.
 */
export async function getSupabaseAndUser(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  user: { id: string; email: string };
} | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { supabase, user: { id: user.id, email: user.email ?? "" } };
}

/**
 * Just the caller's user id, for tool handlers that open their own client.
 * Null when signed out.
 */
export async function getUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}
