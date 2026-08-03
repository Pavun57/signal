import { getSupabaseAndUser } from "@/lib/supabase/server";
import { gmailSearchUrl } from "@/lib/outreach/activity";
import { htmlToDisplayText } from "@/lib/email/html-to-plain";

/**
 * One sent email, with its body and every reply it drew.
 *
 * Split from the list route because the list rides a 10s poll and bodies have
 * no business being re-fetched every ten seconds. This is loaded once, when a
 * row is expanded.
 *
 * RLS does the scoping (see the note in ../route.ts).
 */
/**
 * The row shape this route selects. Declared by hand because PostgREST's
 * inferred types give up on a two-level embed and widen the whole result to an
 * error type.
 */
interface SentDetailRow {
  id: string;
  subject: string;
  to_email: string;
  from_email: string | null;
  status: string;
  sent_at: string;
  message_id: string | null;
  draft: { body_html: string | null; body_text: string | null } | null;
  email_replies: Array<{
    kind: string;
    from_email: string;
    subject: string;
    received_at: string;
    body_text: string | null;
  }> | null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase } = ctx;
  const { id } = await params;

  const { data: sent, error } = await supabase
    .from("sent_emails")
    .select(
      "id, subject, to_email, from_email, status, sent_at, message_id, " +
        "draft:email_drafts(body_html, body_text), " +
        "email_replies(kind, from_email, subject, received_at, body_text)",
    )
    .eq("id", id)
    .maybeSingle<SentDetailRow>();

  if (error) {
    console.error("[activity/detail] query failed:", error);
    return Response.json({ error: "Could not load message" }, { status: 500 });
  }
  // Also the RLS-denied case: a row belonging to someone else reads as absent,
  // which is the correct thing to tell the caller.
  if (!sent) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const draft = Array.isArray(sent.draft) ? sent.draft[0] : sent.draft;

  // The sent body lives only on the draft row, reached through draft_id. That
  // FK is ON DELETE SET NULL and email_drafts cascades from sequences, so
  // deleting a sequence destroys the body while the sent_emails row survives.
  // Say so plainly rather than rendering an empty email.
  const bodyText =
    draft?.body_text ??
    (draft?.body_html ? htmlToDisplayText(draft.body_html) : null);

  const replies = (sent.email_replies ?? [])
    .slice()
    .sort((a, b) => a.received_at.localeCompare(b.received_at));

  return Response.json({
    sent: {
      subject: sent.subject,
      to_email: sent.to_email,
      from_email: sent.from_email,
      sent_at: sent.sent_at,
      status: sent.status,
      body_text: bodyText,
      body_available: bodyText !== null,
    },
    replies,
    gmail_url: gmailSearchUrl(sent.message_id, sent.from_email),
  });
}
