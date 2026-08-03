import { getSupabaseAndUser } from "@/lib/supabase/server";

/**
 * Ownership tests for tools that take a raw uuid.
 *
 * `people` and `organizations` are shared pools: one row per real person or
 * company, deduped across campaigns so enrichment is never paid for twice.
 * That is deliberate, and it means neither table carries an owner, so reading
 * a row can never tell you whether the caller is entitled to it. The claim has
 * to come from something that is scoped, and the campaign join tables are: the
 * contact sits in one of the caller's campaigns, or the company they are filed
 * under does.
 *
 * This is the same test /api/find-email applies before calling into exactly
 * the same email-finding code. /api/enrich has its own copy of the predicate
 * inline; the two are deliberately independent so either can be reverted
 * alone, and they should be kept in step.
 */

/** The RLS-scoped client a tool gets back from getSupabaseAndUser. */
export type ScopedClient = NonNullable<
  Awaited<ReturnType<typeof getSupabaseAndUser>>
>["supabase"];

/** The user_id on a `campaigns` row reached through an !inner join, if any. */
function campaignOwner(row: { campaign?: unknown } | null): string | null {
  return (
    (row?.campaign as unknown as { user_id?: string } | null)?.user_id ?? null
  );
}

/** Is this company in one of the caller's campaigns? */
export async function callerHoldsOrganization(
  supabase: ScopedClient,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("campaign_organizations")
    .select("campaign:campaigns!inner(user_id)")
    .eq("organization_id", organizationId)
    .limit(1)
    .maybeSingle();
  return campaignOwner(data) === userId;
}

/**
 * Is this contact in one of the caller's campaigns, or at a company that is?
 *
 * The company arm is what keeps the standalone company page and the org chart
 * working. Contacts can reach `people` with no campaign link at all -- "Find
 * more people" stores them that way on purpose -- so a link-only test would
 * refuse rows the caller had just created.
 */
export async function callerHoldsPerson(
  supabase: ScopedClient,
  userId: string,
  personId: string,
): Promise<boolean> {
  const { data: link } = await supabase
    .from("campaign_people")
    .select("campaign:campaigns!inner(user_id)")
    .eq("person_id", personId)
    .limit(1)
    .maybeSingle();
  if (campaignOwner(link) === userId) return true;

  const { data: person } = await supabase
    .from("people")
    .select("organization_id")
    .eq("id", personId)
    .maybeSingle();
  const organizationId = (person?.organization_id as string | null) ?? null;
  if (!organizationId) return false;

  return callerHoldsOrganization(supabase, userId, organizationId);
}

/**
 * The refusal a tool returns.
 *
 * Deliberately the same words as a genuinely missing row. Saying "forbidden"
 * for a row that exists and "not found" for one that does not turns the tool
 * into an oracle for which uuids are real, which is most of what an attacker
 * with a uuid to guess wants.
 */
export function notFound(subject: "Contact" | "Company"): { error: string } {
  return { error: `${subject} not found.` };
}

/**
 * The session behind a tool call. Tools run inside the chat request, so this
 * is the same Clerk session the route authenticated.
 */
export async function toolSession(): Promise<{
  supabase: ScopedClient;
  userId: string;
} | null> {
  const ctx = await getSupabaseAndUser();
  if (!ctx) return null;
  return { supabase: ctx.supabase, userId: ctx.user.id };
}
