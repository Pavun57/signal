import { tool } from "ai";
import { z } from "zod";
import { createClient, getSupabaseAndUser } from "@/lib/supabase/server";
import { ExaService } from "@/lib/services/exa-service";
import { trackUsage } from "@/lib/services/cost-tracker";
import {
  claimAndSendDraft,
  type DraftForSend,
} from "@/lib/services/outreach-sender";
import { resolveSenderConfig } from "@/lib/services/email-transport";
import { saveDraft } from "@/lib/email-composition/save";
import {
  applyPattern,
  emailMatchesName,
  getOrgPattern,
  inferPattern,
  isRolePrefix,
  mxCheck,
  recomputeOrgPattern,
  splitName,
  SOURCE_WEIGHT,
  type EmailSource,
  type VerifiedEmail,
} from "@/lib/services/email-pattern";
import {
  getEmailProvider,
  MAX_VERIFICATIONS_PER_PERSON,
  type EmailVerification,
  type VerifyResult,
} from "@/lib/services/email-provider";

// ── Shared findEmail logic ─────────────────────────────────────────────────

const PATTERN_CONFIDENCE_THRESHOLD = 0.5;
// Cap for pattern-derived confidence. Stays strictly below the UI's
// "verified" threshold (0.9) so a pattern guess can never display as verified.
const PATTERN_DERIVED_CONFIDENCE_FACTOR = 0.85;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Confidence awarded to an address a verifier confirmed as deliverable,
 * whatever produced it. This is the point of the whole exercise: proof of
 * delivery outranks provenance, so a pattern guess that verifies is as
 * trustworthy as one scraped off a team page.
 */
const VERIFIED_CONFIDENCE = 0.95;
/** Catch-all domains accept everything, so "deliverable" there proves nothing. */
const CATCH_ALL_CONFIDENCE_CAP = 0.5;
/** The verifier was asked and shrugged — better than unchecked, well short of proof. */
const UNRESOLVED_CONFIDENCE_CAP = 0.6;

/** One address the waterfall produced, before anyone has checked whether it works. */
interface EmailCandidate {
  email: string;
  source: Exclude<EmailSource, "user_entered" | "send_confirmed">;
  /** What we'd have written for this address before verification existed. */
  discoveryConfidence: number;
}

/**
 * Adds a candidate if it is plausible and not already present.
 *
 * Ordering is significance-ordered by the caller, so the first occurrence of an
 * address wins and later duplicates are dropped — that keeps the strongest
 * provenance when two strategies converge on the same string (which they
 * routinely do: an org pattern and a blind {first}.{last} agree whenever the
 * pattern *is* {first}.{last}).
 */
function pushCandidate(
  candidates: EmailCandidate[],
  candidate: EmailCandidate | null,
  first: string | null,
  last: string | null,
): void {
  if (!candidate) return;
  const email = candidate.email.toLowerCase();
  if (isRolePrefix(email.split("@")[0])) return;
  if (!emailMatchesName(email, first, last)) return;
  if (candidates.some((c) => c.email === email)) return;
  candidates.push({ ...candidate, email });
}

/**
 * Finds a work email for a person and, where a provider is configured, proves
 * it exists before writing it.
 *
 * The shape here matters. Every step used to write-and-return the instant it
 * produced a string, which meant the *first* strategy to guess something won,
 * regardless of whether the address was real — and the last strategy is a blind
 * {first}.{last}@domain. Now the strategies only nominate candidates; a
 * verifier decides. That inverts the ranking: proof of delivery outranks
 * provenance, so a pattern guess that verifies beats a scraped address that
 * doesn't.
 *
 * With no provider configured this degrades to the old behaviour — best
 * candidate by discovery order, marked `unchecked` — so a self-hosted instance
 * without a key keeps working exactly as before.
 */
export async function findEmailForPerson(personId: string): Promise<{
  email: string | null;
  source?: string;
  confidence?: number;
  verification?: EmailVerification | "unchecked";
  reason?: string;
  personId: string;
}> {
  const supabase = await createClient();

  const { data: person, error: personErr } = await supabase
    .from("people")
    .select(
      "id, name, title, work_email, personal_email, organization_id, work_email_source, work_email_confidence, work_email_verification, enrichment_data",
    )
    .eq("id", personId)
    .single();

  if (personErr || !person) {
    return { email: null, reason: "Person not found.", personId };
  }

  if (person.work_email) {
    return {
      email: person.work_email,
      source: person.work_email_source ?? "existing",
      confidence: person.work_email_confidence ?? undefined,
      verification: person.work_email_verification ?? "unchecked",
      personId,
    };
  }
  if (person.personal_email) {
    return { email: person.personal_email, source: "existing", personId };
  }

  let domain: string | null = null;
  let orgIsCatchAll: boolean | null = null;
  if (person.organization_id) {
    const { data: org } = await supabase
      .from("organizations")
      .select("domain, name, is_catch_all")
      .eq("id", person.organization_id)
      .single();
    domain = org?.domain ?? null;
    orgIsCatchAll = org?.is_catch_all ?? null;
  }

  const { first, last } = splitName(person.name);
  const provider = getEmailProvider();
  const candidates: EmailCandidate[] = [];

  // The domain has to be able to receive mail at all before any address at it
  // is worth proposing — one DNS lookup gates every domain-derived candidate.
  const domainAcceptsMail = domain ? await mxCheck(domain) : false;

  // ── 1) Org pattern, if we've learned a confident one from verified emails.
  if (domainAcceptsMail && domain && person.organization_id && first) {
    const orgPattern = await getOrgPattern(supabase, person.organization_id);
    if (
      orgPattern?.pattern &&
      orgPattern.confidence >= PATTERN_CONFIDENCE_THRESHOLD
    ) {
      pushCandidate(
        candidates,
        toCandidate(
          applyPattern(orgPattern.pattern, first, last, domain),
          "pattern_derived",
          orgPattern.confidence * PATTERN_DERIVED_CONFIDENCE_FACTOR,
        ),
        first,
        last,
      );
    }
  }

  // ── 2) Paid finder. Placed above Exa because it returns a targeted answer
  //       rather than whatever address happened to sit near the name on a page.
  if (provider?.canFind && domainAcceptsMail && domain && first && last) {
    const hit = await provider.findEmail({
      firstName: first,
      lastName: last,
      domain,
      linkedinUrl: null,
    });
    pushCandidate(
      candidates,
      toCandidate(hit?.email ?? null, "provider_found", hit?.confidence ?? 0.7),
      first,
      last,
    );
  }

  // ── 3) Exa scrape of pages mentioning the person.
  for (const email of await searchEmailsViaExa(
    person.name,
    domain,
    first,
    last,
    personId,
  )) {
    pushCandidate(
      candidates,
      toCandidate(email, "exa_search", SOURCE_WEIGHT.exa_search),
      first,
      last,
    );
  }

  // ── 4) On-the-fly inference from any verified emails already on the org.
  //       Covers the case where the org has evidence but the cached pattern
  //       hasn't been recomputed or sits below the threshold.
  if (domainAcceptsMail && domain && person.organization_id && first && last) {
    const inferred = await inferPatternFromOrg(
      supabase,
      person.organization_id,
    );
    if (inferred?.pattern) {
      pushCandidate(
        candidates,
        toCandidate(
          applyPattern(inferred.pattern, first, last, domain),
          "pattern_derived",
          inferred.confidence * PATTERN_DERIVED_CONFIDENCE_FACTOR,
        ),
        first,
        last,
      );
    }
  }

  // ── 5) Blind {first}.{last}. Last because it is a guess with no evidence
  //       behind it — but a guess a verifier can now confirm or kill.
  if (domainAcceptsMail && domain && first && last) {
    pushCandidate(
      candidates,
      toCandidate(
        applyPattern("{first}.{last}", first, last, domain),
        "pattern_derived",
        0.2,
      ),
      first,
      last,
    );
  }

  if (candidates.length === 0) {
    return {
      email: null,
      reason: "Could not find an email address.",
      personId,
    };
  }

  // ── Verification. Without a provider we cannot check anything, so take the
  //    best candidate as-is and mark it unchecked.
  if (!provider?.canVerify) {
    const best = candidates[0];
    await writeEmailResult(supabase, personId, best, {
      confidence: best.discoveryConfidence,
      verification: "unchecked",
      verifiedBy: null,
    });
    return {
      email: best.email,
      source: best.source,
      confidence: best.discoveryConfidence,
      verification: "unchecked",
      personId,
    };
  }

  const rejected: string[] = [];
  let fallback: { candidate: EmailCandidate; result: VerifyResult } | null =
    null;

  for (const candidate of candidates.slice(0, MAX_VERIFICATIONS_PER_PERSON)) {
    const result = await provider.verifyEmail(candidate.email);

    // Cache the domain's catch-all status the first time we learn it — it is a
    // property of the MX config, not of this address, and re-probing it per
    // contact bills once per person at the same company.
    if (orgIsCatchAll === null && person.organization_id && result.catchAll) {
      orgIsCatchAll = true;
      await supabase
        .from("organizations")
        .update({
          is_catch_all: true,
          catch_all_checked_at: new Date().toISOString(),
        })
        .eq("id", person.organization_id);
    }

    if (result.status === "undeliverable") {
      rejected.push(candidate.email);
      continue;
    }

    const catchAll = result.catchAll || orgIsCatchAll === true;

    if (result.status === "deliverable" && !catchAll) {
      await writeEmailResult(supabase, personId, candidate, {
        confidence: VERIFIED_CONFIDENCE,
        verification: "deliverable",
        verifiedBy: provider.id,
      });
      await recordNegatives(
        supabase,
        personId,
        person.enrichment_data,
        rejected,
      );
      // A confirmed address is also pattern evidence for everyone else at the
      // org — this is what finally bootstraps the pattern flywheel, which
      // cannot start from guesses alone.
      if (person.organization_id) {
        await recomputeOrgPattern(supabase, person.organization_id);
      }
      return {
        email: candidate.email,
        source: candidate.source,
        confidence: VERIFIED_CONFIDENCE,
        verification: "deliverable",
        personId,
      };
    }

    // Deliverable-but-catch-all, risky, or unknown. Keep the first one as a
    // fallback and carry on looking for something provable.
    if (!fallback) fallback = { candidate, result };
  }

  await recordNegatives(supabase, personId, person.enrichment_data, rejected);

  if (!fallback) {
    return {
      email: null,
      reason:
        rejected.length > 0
          ? `Found ${rejected.length} candidate address(es) but the verifier rejected every one.`
          : "Could not find an email address.",
      personId,
    };
  }

  // Nothing proved deliverable. Write the best unproven candidate, capped well
  // below the verified threshold so the UI and the send gate both treat it as
  // what it is.
  const catchAll = fallback.result.catchAll || orgIsCatchAll === true;
  const verification: EmailVerification = catchAll
    ? "risky"
    : fallback.result.status;
  const confidence = Math.min(
    fallback.candidate.discoveryConfidence,
    catchAll ? CATCH_ALL_CONFIDENCE_CAP : UNRESOLVED_CONFIDENCE_CAP,
  );

  await writeEmailResult(supabase, personId, fallback.candidate, {
    confidence,
    verification,
    verifiedBy: provider.id,
  });

  return {
    email: fallback.candidate.email,
    source: fallback.candidate.source,
    confidence,
    verification,
    personId,
  };
}

/** Null-safe candidate constructor — applyPattern returns null when unfillable. */
function toCandidate(
  email: string | null,
  source: EmailCandidate["source"],
  discoveryConfidence: number,
): EmailCandidate | null {
  return email ? { email, source, discoveryConfidence } : null;
}

/** Persists a settled address plus everything we know about how sure we are. */
async function writeEmailResult(
  supabase: Awaited<ReturnType<typeof createClient>>,
  personId: string,
  candidate: EmailCandidate,
  meta: {
    confidence: number;
    verification: EmailVerification | "unchecked";
    verifiedBy: string | null;
  },
): Promise<void> {
  await supabase
    .from("people")
    .update({
      work_email: candidate.email,
      work_email_source: candidate.source,
      work_email_confidence: meta.confidence,
      work_email_verification: meta.verification,
      work_email_verified_by: meta.verifiedBy,
      work_email_verified_at: hasPositiveEvidence(
        candidate.source,
        meta.verification,
      )
        ? new Date().toISOString()
        : null,
    })
    .eq("id", personId);
}

/**
 * Whether we hold independent evidence that this address is real — the question
 * `work_email_verified_at` actually answers, and what recomputeOrgPattern reads
 * to decide which addresses may inform an org's pattern.
 *
 * Two ways to earn it: a verifier confirmed the mailbox, or the address was
 * observed somewhere real (a team page, a search result, a provider lookup)
 * rather than constructed by us. `pattern_derived` is the one source that is
 * pure inference, so it never qualifies on its own — otherwise a guess would
 * become evidence for the very pattern that produced it, and the pattern would
 * confirm itself out of nothing.
 */
function hasPositiveEvidence(
  source: EmailCandidate["source"],
  verification: EmailVerification | "unchecked",
): boolean {
  if (verification === "deliverable") return true;
  return source !== "pattern_derived";
}

/**
 * Remembers addresses a verifier rejected, so a re-run doesn't pay to be told
 * the same thing twice. Written straight to enrichment_data rather than via
 * mergeEnrichmentData because that helper also flips enrichment_status to
 * "enriched", which a failed email lookup has not earned.
 */
async function recordNegatives(
  supabase: Awaited<ReturnType<typeof createClient>>,
  personId: string,
  existing: unknown,
  rejected: string[],
): Promise<void> {
  if (rejected.length === 0) return;
  const base = (existing as Record<string, unknown>) ?? {};
  const priorRaw = base.rejectedEmails;
  const prior = Array.isArray(priorRaw) ? (priorRaw as string[]) : [];
  await supabase
    .from("people")
    .update({
      enrichment_data: {
        ...base,
        rejectedEmails: [...new Set([...prior, ...rejected])],
      },
    })
    .eq("id", personId);
}

/** Scrapes candidate addresses for a person out of Exa result text. */
async function searchEmailsViaExa(
  name: string,
  domain: string | null,
  first: string | null,
  last: string | null,
  personId: string,
): Promise<string[]> {
  const searchQuery = domain
    ? `"${name}" "${domain}" email`
    : `"${name}" email contact`;
  const onDomain: string[] = [];
  const offDomain: string[] = [];

  try {
    const exa = new ExaService();
    const results = await exa.search(searchQuery, {
      numResults: 5,
      includeText: true,
    });

    for (const result of results.results) {
      if (!result.text) continue;
      for (const match of result.text.match(EMAIL_REGEX) ?? []) {
        const lower = match.toLowerCase();
        const candidateDomain = lower.slice(lower.lastIndexOf("@") + 1);
        if (candidateDomain === "example.com") continue;
        if (isRolePrefix(lower.split("@")[0])) continue;
        if (!emailMatchesName(lower, first, last)) continue;
        if (domain && lower.endsWith(`@${domain}`)) onDomain.push(lower);
        else offDomain.push(lower);
      }
    }

    trackUsage({
      service: "exa",
      operation: "find-email",
      estimated_cost_usd: 0.007,
      metadata: { personId, query: searchQuery },
    });
  } catch {
    // Exa unavailable — the other strategies still have their say.
  }

  // Company-domain hits first: an address at the employer's own domain is
  // better evidence than a personal one found on the same page.
  return [...onDomain, ...offDomain];
}

/**
 * Infers an email pattern from the org's already-verified emails, right now,
 * rather than trusting the cached column.
 */
async function inferPatternFromOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
): Promise<{ pattern: string | null; confidence: number } | null> {
  const { data: orgPeople } = await supabase
    .from("people")
    .select("name, work_email, work_email_source, work_email_verified_at")
    .eq("organization_id", organizationId)
    .not("work_email", "is", null)
    .not("work_email_verified_at", "is", null);

  const evidence: VerifiedEmail[] = [];
  for (const p of orgPeople ?? []) {
    if (!p.work_email || !p.work_email_source) continue;
    if (p.work_email_source === "pattern_derived") continue;
    const split = splitName(p.name);
    if (!split.first || !split.last) continue;
    evidence.push({
      email: p.work_email,
      firstName: split.first,
      lastName: split.last,
      source: p.work_email_source,
    });
  }

  if (evidence.length === 0) return null;
  const inferred = inferPattern(evidence);
  return inferred.pattern
    ? { pattern: inferred.pattern, confidence: inferred.confidence }
    : null;
}

// ── findEmail ──────────────────────────────────────────────────────────────

export const findEmail = tool({
  description:
    "Discover the email address for a contact using Exa search and common email pattern guessing. Returns the email if already known. Use this before writeEmail if the contact has no email.",
  inputSchema: z.object({
    personId: z.string().uuid().describe("Person ID to find email for."),
  }),
  execute: async ({ personId }) => findEmailForPerson(personId),
});

// ── findEmails (batch) ─────────────────────────────────────────────────────

export const findEmails = tool({
  description:
    "Batch-discover email addresses for multiple contacts. Skips contacts that already have emails. Returns found and not-found lists.",
  inputSchema: z.object({
    personIds: z.array(z.string().uuid()).describe("Array of person IDs."),
  }),
  execute: async ({ personIds }) => {
    const found: Array<{ personId: string; email: string }> = [];
    const notFound: string[] = [];

    for (const personId of personIds) {
      try {
        const result = await findEmailForPerson(personId);
        if (result.email) {
          found.push({ personId, email: result.email });
        } else {
          notFound.push(personId);
        }
      } catch {
        notFound.push(personId);
      }
    }

    return {
      found,
      notFound,
      summary: `Found emails for ${found.length} of ${personIds.length} contacts. ${notFound.length} not found.`,
    };
  },
});

// ── writeEmail ─────────────────────────────────────────────────────────────

export const writeEmail = tool({
  description:
    "Compose an email draft and save it to the database. This does NOT send the email -- it creates a draft for the user to review. The user must confirm before you call sendEmail.",
  inputSchema: z.object({
    campaignId: z.string().uuid().describe("Campaign ID."),
    personId: z.string().uuid().describe("Person ID (from campaign contacts)."),
    subject: z.string().describe("Email subject line."),
    bodyHtml: z.string().describe("Email body as HTML."),
    bodyText: z
      .string()
      .optional()
      .describe("Plain text version of the email body."),
    sequenceId: z
      .string()
      .uuid()
      .optional()
      .describe("Sequence ID if this draft is part of a sequence."),
    sequenceStepId: z
      .string()
      .uuid()
      .optional()
      .describe("Sequence step ID for this draft."),
    enrollmentId: z
      .string()
      .uuid()
      .optional()
      .describe("Sequence enrollment ID for the contact."),
    aiReasoning: z
      .string()
      .optional()
      .describe("Explanation of why the email was written this way."),
  }),
  execute: async (input) => {
    const ctx = await getSupabaseAndUser();
    if (!ctx) {
      return {
        error:
          "No authenticated session available in tool context. Ask the user to sign in.",
      };
    }
    const { supabase, user } = ctx;

    const { data: campaignRow } = await supabase
      .from("campaigns")
      .select("user_id")
      .eq("id", input.campaignId)
      .single();
    const userId: string = campaignRow?.user_id ?? user.id;

    const result = await saveDraft(supabase, { ...input, userId });

    if (!result.ok) {
      return { error: result.error };
    }

    return {
      draftId: result.draftId,
      to: result.to,
      subject: result.subject,
      status: "draft",
      message:
        "Draft saved. Show it to the user and wait for confirmation before calling sendEmail.",
    };
  },
});

// ── sendEmail ──────────────────────────────────────────────────────────────

export const sendEmail = tool({
  description:
    "Send a previously written email draft via the user's connected Gmail. Only approved drafts can be sent: ad-hoc drafts from writeEmail are approved at creation, but sequence drafts must be approved by the user in the outreach review queue first. Rejected drafts can never be sent.",
  inputSchema: z.object({
    draftId: z.string().uuid().describe("Draft ID to send."),
  }),
  execute: async ({ draftId }) => {
    const supabase = await createClient();

    const { data: draft, error: draftErr } = await supabase
      .from("email_drafts")
      .select("*")
      .eq("id", draftId)
      .single();

    if (draftErr || !draft) {
      return { error: "Draft not found." };
    }

    if (draft.status !== "draft") {
      return {
        error: `This draft has already been ${draft.status}. Cannot send again.`,
      };
    }

    // Hard gate, not advisory: the review decision lives in the DB, and this
    // tool's inputs can be influenced by scraped web content. The tool
    // description alone must never be what stands between a rejected draft
    // and a prospect's inbox.
    if (draft.review_status === "rejected") {
      return {
        error:
          "This draft was rejected in review and cannot be sent. Write a new draft if the user wants to contact this person.",
      };
    }
    if (draft.review_status !== "approved") {
      return {
        error:
          "This draft is awaiting review. The user must approve it in the outreach review queue before it can be sent.",
      };
    }

    const sender = await resolveSenderConfig(supabase, draft.user_id);
    if ("error" in sender) {
      return { error: sender.error };
    }

    const result = await claimAndSendDraft(
      supabase,
      draft as DraftForSend,
      sender,
    );

    if (!result.ok) {
      return { error: `Failed to send email: ${result.reason}` };
    }

    return {
      emailId: result.messageId,
      to: draft.to_email,
      subject: draft.subject,
      status: "sent",
    };
  },
});

// ── listDrafts ─────────────────────────────────────────────────────────────

export const listDrafts = tool({
  description: "List unsent email drafts, optionally filtered by campaign.",
  inputSchema: z.object({
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Filter drafts by campaign ID."),
  }),
  execute: async ({ campaignId }) => {
    const supabase = await createClient();

    let query = supabase
      .from("email_drafts")
      .select(
        "id, campaign_id, person_id, to_email, subject, status, created_at",
      )
      .eq("status", "draft")
      .order("created_at", { ascending: false });

    if (campaignId) {
      query = query.eq("campaign_id", campaignId);
    }

    const { data, error } = await query;
    if (error) return { error: error.message };

    return { drafts: data ?? [], count: data?.length ?? 0 };
  },
});

// ── discardDraft ───────────────────────────────────────────────────────────

export const discardDraft = tool({
  description: "Discard an email draft so it won't be sent.",
  inputSchema: z.object({
    draftId: z.string().uuid().describe("Draft ID to discard."),
  }),
  execute: async ({ draftId }) => {
    const supabase = await createClient();

    const { error } = await supabase
      .from("email_drafts")
      .update({
        status: "discarded",
        updated_at: new Date().toISOString(),
      })
      .eq("id", draftId)
      .eq("status", "draft");

    if (error) return { error: error.message };
    return { draftId, status: "discarded" };
  },
});

// ── sendBulkEmails ─────────────────────────────────────────────────────────

export const sendBulkEmails = tool({
  description:
    "Send multiple email drafts at once. Only APPROVED drafts are sent — sequence drafts awaiting review or rejected in the review queue are excluded and reported back. If no draftIds provided, sends all approved unsent drafts for the campaign. Only call after user confirms sending.",
  inputSchema: z.object({
    campaignId: z.string().uuid().describe("Campaign ID."),
    draftIds: z
      .array(z.string().uuid())
      .optional()
      .describe(
        "Specific draft IDs to send. If omitted, sends all approved drafts for the campaign.",
      ),
  }),
  execute: async ({ campaignId, draftIds }) => {
    const supabase = await createClient();

    // Count everything in scope first so unapproved drafts are reported,
    // never silently dropped.
    let scopeQuery = supabase
      .from("email_drafts")
      .select("id, review_status")
      .eq("campaign_id", campaignId)
      .eq("status", "draft");
    if (draftIds && draftIds.length > 0) {
      scopeQuery = scopeQuery.in("id", draftIds);
    }
    const { data: inScope, error: scopeError } = await scopeQuery;
    if (scopeError) return { error: scopeError.message };
    if (!inScope || inScope.length === 0) {
      return { error: "No drafts found to send." };
    }

    const awaitingReview = inScope.filter(
      (d) => d.review_status !== "approved" && d.review_status !== "rejected",
    ).length;
    const rejected = inScope.filter(
      (d) => d.review_status === "rejected",
    ).length;
    const approvedIds = inScope
      .filter((d) => d.review_status === "approved")
      .map((d) => d.id);

    if (approvedIds.length === 0) {
      return {
        error: `None of the ${inScope.length} drafts are approved (${awaitingReview} awaiting review, ${rejected} rejected). The user must approve them in the outreach review queue first.`,
      };
    }

    const { data: drafts, error } = await supabase
      .from("email_drafts")
      .select("*")
      .in("id", approvedIds)
      .eq("review_status", "approved")
      .eq("status", "draft");
    if (error) return { error: error.message };

    const firstDraft = (drafts ?? [])[0];
    if (!firstDraft) {
      return { error: "No sendable drafts found." };
    }
    const sender = await resolveSenderConfig(supabase, firstDraft.user_id);
    if ("error" in sender) {
      return { error: sender.error };
    }

    const results: Array<{ draftId: string; status: string; error?: string }> =
      [];

    // Sequential on purpose: keeps Gmail SMTP happy, and each send claims its
    // draft atomically so a concurrent cron can't double-send any of them.
    for (const draft of drafts ?? []) {
      const result = await claimAndSendDraft(
        supabase,
        draft as DraftForSend,
        sender,
      );
      if (result.ok) {
        results.push({ draftId: draft.id, status: "sent" });
      } else if (result.reason.includes("claimed")) {
        results.push({
          draftId: draft.id,
          status: "skipped",
          error: result.reason,
        });
      } else {
        results.push({
          draftId: draft.id,
          status: "failed",
          error: result.reason,
        });
      }
    }

    const sent = results.filter((r) => r.status === "sent").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skippedHeld = awaitingReview + rejected;

    return {
      sent,
      failed,
      awaitingReview,
      rejected,
      total: inScope.length,
      results,
      summary:
        `Sent ${sent} of ${approvedIds.length} approved drafts.` +
        (failed > 0 ? ` ${failed} failed.` : "") +
        (skippedHeld > 0
          ? ` ${awaitingReview} held for review and ${rejected} rejected — not sent.`
          : ""),
    };
  },
});
