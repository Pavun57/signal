"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Email/password auth against Supabase. Sign-up behaviour depends on the
 * project's email-confirmation setting: with confirmation off (self-host
 * default) signUp returns a live session and the user goes straight in;
 * with it on, they get a "check your inbox" state instead.
 */
export function AuthForm({ mode }: { readonly mode: "login" | "signup" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isLogin = mode === "login";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);

    try {
      const supabase = createClient();
      if (isLogin) {
        const { error: signInError } =
          await supabase.auth.signInWithPassword({ email, password });
        if (signInError) {
          setError(signInError.message);
          return;
        }
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        });
        if (signUpError) {
          setError(signUpError.message);
          return;
        }
        if (!data.session) {
          setNotice(
            "Account created. Check your inbox to confirm your email, then sign in.",
          );
          return;
        }
      }
      router.push("/");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-semibold">Signal</h1>
          <p className="text-muted-foreground text-sm">
            {isLogin
              ? "Sign in to your account"
              : "Create your account"}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@yourcompany.com"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          {notice && <p className="text-sm text-green-600">{notice}</p>}
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting
              ? "One moment…"
              : isLogin
                ? "Sign in"
                : "Create account"}
          </Button>
        </form>
        <p className="text-muted-foreground mt-4 text-center text-sm">
          {isLogin ? (
            <>
              No account yet?{" "}
              <Link href="/signup" className="underline underline-offset-4">
                Sign up
              </Link>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <Link href="/login" className="underline underline-offset-4">
                Sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
