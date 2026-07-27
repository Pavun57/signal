import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { verifyQStashSignature } from "@/lib/services/qstash";

/**
 * Draft cleanup endpoint. Call via a QStash schedule (the route is public,
 * so the signature check is the only auth).
 * - Recovers drafts stranded in "queued" by a send process that died
 * - Deletes discarded drafts older than 7 days
 * - Deletes stale drafts (never sent) older than 30 days
 */
export async function POST(request: Request) {
  try {
    await verifyQStashSignature(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  const supabase = getAdminClient();

  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Recover drafts stranded in "queued": the send claim was taken but the
  // process died before finishing. If a sent_emails row exists the message
  // left the building — finish the bookkeeping as "sent". If none exists the
  // send (almost certainly) never happened — release back to "draft" so it's
  // retryable. The residual risk (crash in the instant between AgentMail
  // accepting the send and the sent_emails insert) is taken deliberately:
  // after 24h, a stuck invisible draft is worse than the sliver of a chance
  // of a duplicate.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let recoveredSent = 0;
  let recoveredDraft = 0;

  const { data: stuck } = await supabase
    .from("email_drafts")
    .select("id")
    .eq("status", "queued")
    .lt("updated_at", dayAgo);

  if (stuck && stuck.length > 0) {
    const ids = stuck.map((d) => d.id);
    const { data: sentRows } = await supabase
      .from("sent_emails")
      .select("draft_id")
      .in("draft_id", ids);
    const sentIds = new Set((sentRows ?? []).map((r) => r.draft_id));

    const wasSent = ids.filter((id) => sentIds.has(id));
    const neverSent = ids.filter((id) => !sentIds.has(id));
    const now = new Date().toISOString();

    if (wasSent.length > 0) {
      await supabase
        .from("email_drafts")
        .update({ status: "sent", updated_at: now })
        .in("id", wasSent)
        .eq("status", "queued");
      recoveredSent = wasSent.length;
    }
    if (neverSent.length > 0) {
      await supabase
        .from("email_drafts")
        .update({ status: "draft", updated_at: now })
        .in("id", neverSent)
        .eq("status", "queued");
      recoveredDraft = neverSent.length;
    }
  }

  // Delete old discarded drafts
  const { count: discardedCount } = await supabase
    .from("email_drafts")
    .delete({ count: "exact" })
    .eq("status", "discarded")
    .lt("created_at", sevenDaysAgo);

  // Delete stale unsent drafts
  const { count: staleCount } = await supabase
    .from("email_drafts")
    .delete({ count: "exact" })
    .eq("status", "draft")
    .lt("created_at", thirtyDaysAgo);

  return NextResponse.json({
    cleaned: {
      discarded: discardedCount ?? 0,
      stale: staleCount ?? 0,
    },
    recovered: {
      markedSent: recoveredSent,
      returnedToDraft: recoveredDraft,
    },
  });
}
