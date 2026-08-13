"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

import { createClient } from "@/lib/supabase/client";

export function PostHogIdentify() {
  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getUser().then(({ data }) => {
      const user = data.user;
      if (!user) return;
      posthog.identify(user.id, {
        email: user.email,
        name: (user.user_metadata as { full_name?: string }).full_name,
      });
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") posthog.reset();
    });
    return () => subscription.unsubscribe();
  }, []);

  return null;
}
