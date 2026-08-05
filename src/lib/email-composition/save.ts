import type { SupabaseClient } from "@supabase/supabase-js";

export type SaveDraftInput = {
  userId: string;
  campaignId: string;
  personId: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string | null;
  sequenceId?: string | null;
  sequenceStepId?: string | null;
  enrollmentId?: string | null;
  aiReasoning?: string | null;
};

export type SaveDraftResult =
  | {
      ok: true;
      draftId: string;
      to: string;
      subject: string;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Inserts an email_drafts row. Shared by writeEmail (ad-hoc) and
 * draftEmailsForSequence (fan-out). Returns a discriminated union so
 * callers decide how to surface errors.
 */
export async function saveDraft(
  supabase: SupabaseClient,
  input: SaveDraftInput,
): Promise<SaveDraftResult> {
  const { data: person } = await supabase
    .from("people")
    .select("id, name, work_email, personal_email")
    .eq("id", input.personId)
    .single();

  if (!person) {
    return { ok: false, error: "Person not found." };
  }

  const toEmail = person.work_email ?? person.personal_email;
  if (!toEmail) {
    return {
      ok: false,
      error:
        "No email address on this contact. Use findEmail to discover one first.",
    };
  }

  const { data: cp } = await supabase
    .from("campaign_people")
    .select("id")
    .eq("campaign_id", input.campaignId)
    .eq("person_id", input.personId)
    .single();

  if (!cp) {
    return {
      ok: false,
      error: "Person is not linked to the specified campaign.",
    };
  }

  const { data: draft, error } = await supabase
    .from("email_drafts")
    .insert({
      user_id: input.userId,
      campaign_id: input.campaignId,
      person_id: input.personId,
      campaign_people_id: cp.id,
      to_email: toEmail,
      subject: input.subject,
      body_html: input.bodyHtml,
      body_text: input.bodyText ?? null,
      status: "draft",
      sequence_id: input.sequenceId ?? null,
      sequence_step_id: input.sequenceStepId ?? null,
      enrollment_id: input.enrollmentId ?? null,
      ai_reasoning: input.aiReasoning ?? null,
      // Everything the agent writes waits for a human, sequence or not.
      //
      // An ad-hoc writeEmail draft used to be born "approved", which is the
      // one state sendEmail's gate lets through -- so on that path the only
      // thing between the model and a prospect's inbox was a sentence in the
      // system prompt, sitting in the same context window as the scraped page
      // that may have asked for the email. email-tools.ts says in its own
      // comment that prompt text must never be that control; this made it so.
      review_status: "pending",
    })
    .select("id, to_email, subject")
    .single();

  if (error || !draft) {
    return {
      ok: false,
      error: `Failed to save draft: ${error?.message ?? "unknown error"}`,
    };
  }

  return {
    ok: true,
    draftId: draft.id,
    to: draft.to_email,
    subject: draft.subject,
  };
}

/**
 * Flip a signal-drafted email straight to approved, skipping the review
 * queue. ONLY callable from the signal outreach path, and only when the
 * tracking config opted in (auto_send) AND the intent verdict was
 * high-confidence. Guarded on pending so it can never resurrect a
 * rejected draft. Every other writer of 'approved' is a human click in
 * /outreach/review — keep it that way.
 */
export async function autoApproveDraft(
  supabase: SupabaseClient,
  draftId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("email_drafts")
    .update({ review_status: "approved" })
    .eq("id", draftId)
    .eq("review_status", "pending")
    .select("id")
    .maybeSingle();
  return !error && !!data;
}
