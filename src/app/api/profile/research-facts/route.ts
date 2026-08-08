import { NextResponse } from "next/server";

import { z } from "zod";

import { loadAllSenderFacts } from "@/lib/sender-facts";
import { dedupeFacts, researchSender } from "@/lib/services/sender-research";
import { getSupabaseAndUser } from "@/lib/supabase/server";
import type { UserProfile } from "@/lib/types/profile";

// Exa searches across up to four profile URLs plus one extraction call can
// take tens of seconds; same budget as the other research-shaped routes.
export const maxDuration = 120;

const BodySchema = z.object({
  profileId: z.string().uuid(),
});

/**
 * Research the sender behind a profile and append the resulting facts to the
 * profile's fact bank. Runs server-side so the Exa key never reaches the
 * browser; the profile page's "Research my profile" button posts here.
 */
export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "profileId must be a UUID" },
      { status: 400 },
    );
  }

  // RLS-scoped read: someone else's profileId resolves to nothing, so a
  // foreign id gets the same 404 as a nonexistent one.
  const { data: profile } = await supabase
    .from("user_profile")
    .select("*")
    .eq("id", parsed.data.profileId)
    .maybeSingle();

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const result = await researchSender(profile as UserProfile, user.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Dedupe against the FULL bank, and refuse on a failed read: an empty or
  // truncated baseline re-inserts every fact that already exists, bloating
  // the bank fed into every composed email.
  const existingRes = await loadAllSenderFacts(supabase, profile.id);
  if (!existingRes.ok) {
    return NextResponse.json(
      {
        error: `Could not load the existing fact bank (${existingRes.error}), so nothing was saved: inserting without it would duplicate facts. Retry.`,
      },
      { status: 500 },
    );
  }
  const survivors = dedupeFacts(result.facts, existingRes.facts);
  const skippedAsDuplicates = result.facts.length - survivors.length;

  if (survivors.length === 0) {
    return NextResponse.json({ added: 0, skippedAsDuplicates });
  }

  const { data: inserted, error } = await supabase
    .from("sender_facts")
    .insert(
      survivors.map((f) => ({
        user_id: user.id,
        profile_id: profile.id,
        category: f.category,
        fact: f.fact,
        source: "research",
      })),
    )
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    added: inserted?.length ?? survivors.length,
    skippedAsDuplicates,
  });
}
