"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * The signed-in user's id on the client, or null until known / when signed
 * out. Replaces Clerk's useAuth().userId for pages that tag saved records
 * with the owner.
 */
export function useUserId(): string | null {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  return userId;
}
