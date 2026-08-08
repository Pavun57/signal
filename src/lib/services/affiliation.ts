import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeLinkedInUrl } from "@/lib/services/knowledge-base";
import { WebExtractionService } from "@/lib/services/web-extraction-service";

/**
 * How sure are we that this person works at this company?
 *
 * `people.organization_id` was a bare FK: set once, never revisited, with no
 * record of what convinced us. That made a wrong link invisible (nothing
 * distinguishes a scraped guess from a confirmed employee) and permanent
 * (findOrCreatePerson only ever filled it when null, so even a real job change
 * could not correct it).
 *
 * Deliberately shaped like email-pattern.ts — a weight per source, a monotonic
 * writer that never downgrades — so affiliation and email provenance read as
 * one system rather than two competing conventions.
 */

export type AffiliationSource =
  | "user_entered"
  | "email_domain"
  | "team_page"
  | "linkedin_profile"
  | "llm_verified"
  | "search_stamp"
  | "former_employee"
  | "employer_mismatch"
  | "user_rejected";

export const AFFILIATION_WEIGHT: Record<AffiliationSource, number> = {
  /** A human said so. Nothing outranks it. */
  user_entered: 1.0,
  /**
   * A human said the opposite: "not here", from the review queue or the org
   * chart. Level with user_entered because it is the same authority pointed the
   * other way, and the table only worked in one direction before.
   *
   * A rejection used to be written as nothing at all: the endpoint nulled
   * organization_id and all four provenance columns, which this function scores
   * at -1, below a bare search stamp. So the next discovery run re-attached the
   * person at 0.2 and they reappeared in the queue the user had just cleared.
   * Recording the decision at 1.0 is what terminates that loop, since no machine
   * source is strictly stronger.
   */
  user_rejected: 1.0,
  /**
   * A verifier confirmed a deliverable mailbox at the company's own domain.
   * The strongest machine signal available: someone who answers mail at
   * acme.com works at Acme. Only granted when the domain is NOT catch-all —
   * a catch-all accepts anything and proves nothing.
   */
  email_domain: 0.95,
  /** Listed on the company's own website. They published it about themselves. */
  team_page: 0.9,
  /** Their LinkedIn profile names this employer. */
  linkedin_profile: 0.8,
  /**
   * Their profile shows a dated stint at this company that has already ended.
   * Same strength as linkedin_profile because it is the same evidence read the
   * same way: strong enough to displace a search stamp or an LLM guess, never
   * strong enough to overrule the company's own team page or a human.
   */
  former_employee: 0.8,
  /** Their profile names a DIFFERENT employer and never mentions this one. */
  employer_mismatch: 0.8,
  /** An LLM read the evidence and judged them an employee. */
  llm_verified: 0.6,
  /**
   * They came back from a search we ran for this company. This is the weakest
   * possible claim and, before this work, was the *only* thing behind most
   * affiliations — searchPeople stamped every result with the target org.
   */
  search_stamp: 0.2,
};

// Defined in its own client-safe module (client components need it and this
// module drags server-only imports into their bundle); re-exported here so
// server callers keep their import path.
import { AFFILIATION_SEND_THRESHOLD } from "@/lib/affiliation-threshold";
export { AFFILIATION_SEND_THRESHOLD };

/**
 * What a call to recordAffiliation actually did.
 *
 * Returned rather than inferred, because refusing the write is a routine
 * outcome here, not an error: the monotonic guard no-ops whenever the stored
 * evidence outranks the incoming claim. Callers used to assume the verdict they
 * passed in was the state that resulted, so a refused write was reported to the
 * user as "verified" or "departed" while the row said neither. A failed UPDATE
 * was worse still, since nothing read the error at all.
 *
 * `reason` is a short machine-readable code for a refusal by the guard, and the
 * Postgres message for a refusal by the database.
 */
export interface AffiliationWrite {
  written: boolean;
  reason?: string;
  /**
   * True when a detaching write was refused because the person is not filed
   * under the company the verdict was about.
   *
   * A flag rather than a string the caller has to match, because the two
   * refusals mean opposite things to a caller and getting them the wrong way
   * round is silent. Every other refusal says "this person is filed HERE and
   * the evidence on file outranks yours", so they belong in the contact list,
   * unchanged. This one says "this person is filed somewhere else entirely", so
   * they are not a contact here at all. A test fake that does not model the
   * field reads `undefined` and takes the conservative branch.
   */
  notAtJudgedOrg?: boolean;
}

/**
 * Records why we believe someone works somewhere. Monotonic in the same sense
 * as recordVerifiedEmail: a weaker signal never overwrites a stronger one.
 *
 * The cross-org case is the interesting one. Stronger evidence for a
 * *different* employer does move the person — that is a job change, or a
 * correction of a bad stamp — while equal-or-weaker evidence is ignored. That
 * is what makes affiliation revisable at all.
 *
 * Reports back whether the row changed. Read it: acting on the verdict you
 * passed in rather than on the result is how a person sitting at
 * organization_id = null gets counted as a verified contact.
 */
export async function recordAffiliation(
  supabase: SupabaseClient,
  args: {
    personId: string;
    organizationId: string | null;
    source: AffiliationSource;
    evidence: string;
    /**
     * Which company the verdict was about. Required on a detaching write
     * (organizationId null), ignored on an attaching one.
     *
     * Without it, `organizationId: null` means "detach from wherever you are",
     * and a verdict about one company acts on every other. Measured on the live
     * pipeline: a "find more people" run on Browserbase pulls back someone who
     * works at Box, the judge correctly rejects them, and the write deletes
     * them from Box. Being right about the judged company was what caused the
     * damage, and `people` is a shared pool across every user on an instance.
     */
    detachedFrom?: string | null;
  },
): Promise<AffiliationWrite> {
  const {
    personId,
    organizationId,
    source,
    evidence,
    detachedFrom = null,
  } = args;
  const incoming = AFFILIATION_WEIGHT[source];

  const { data: person } = await supabase
    .from("people")
    .select(
      "organization_id, affiliation_source, affiliation_confidence, affiliation_detached_from",
    )
    .eq("id", personId)
    .maybeSingle();

  if (!person) return { written: false, reason: "person_not_found" };

  const existingSource = person.affiliation_source as AffiliationSource | null;
  // A pre-existing link with no recorded source is legacy data, and we know
  // nothing about how it got there — treat it as the weakest possible claim
  // rather than as unassailable.
  const existingWeight = existingSource
    ? AFFILIATION_WEIGHT[existingSource]
    : person.organization_id
      ? AFFILIATION_WEIGHT.search_stamp
      : -1;

  // A person explicitly assigned by a human always moves. Requiring strictly
  // more than the existing weight would make someone already at `user_entered`
  // (1.0) unmovable — nothing outranks 1.0 — so reassigning a contact you had
  // previously assigned by hand would silently no-op while the endpoint
  // returned success.
  //
  // `user_rejected` is in here for exactly the same reason, in the other
  // direction: it is also 1.0, so "not here" on someone a human had confirmed
  // is not STRICTLY stronger and case 1 would refuse it. That is the org
  // chart's Remove button failing on precisely the people its Add dialog put
  // there, and a human being locked out of changing their own mind. It does not
  // widen what a detach can reach: the scope check below runs first, so
  // rejecting someone at a company they are not filed under is still refused
  // however authoritative the source.
  const humanOverride = source === "user_entered" || source === "user_rejected";

  const detaching = organizationId === null;
  const wasDetached = person.organization_id === null;

  // Scope first, and before the human override, because this is not a question
  // of how strong the evidence is. Detaching someone from a company they are
  // not filed under is a claim about a row that was never in scope, however
  // authoritative the source. The check compares the person's CURRENT employer
  // rather than the stored affiliation_detached_from, so a stale value in that
  // column can never block a legitimate detach.
  if (detaching) {
    if (!detachedFrom) {
      // "Detach from wherever you are" is deliberately not expressible.
      return { written: false, reason: "detach_did_not_name_a_company" };
    }
    if (person.organization_id !== detachedFrom) {
      return {
        written: false,
        reason: "not_attached_to_the_company_that_was_judged",
        notAtJudgedOrg: true,
      };
    }
  }

  // Four cases, not two. The first two are the pre-existing rules; the last two
  // are the difference between a person who is attached somewhere and a person
  // who is attached nowhere, which the old sameOrg / cross-org split could not
  // express and which made every detach permanent.
  if (!humanOverride) {
    if (detaching) {
      // Case 1: detaching a person from the company they are filed under (the
      // scope check above proves that is what this is). Requires STRICTLY
      // stronger evidence than what put them there, so a scraped snapshot at
      // 0.8 cannot overrule the company's own team page at 0.9.
      if (incoming <= existingWeight) {
        return { written: false, reason: "not_stronger_than_existing" };
      }
    } else if (wasDetached) {
      // Case 2: attaching someone who is attached NOWHERE.
      if (organizationId === person.affiliation_detached_from) {
        // 2a: back to the company that rejected them. This is the one case the
        // original stickiness was actually about ("cannot re-file them under
        // the same wrong company"), so it keeps the strictly-greater rule:
        // team_page (0.9) still can, another llm_verified (0.6) still cannot.
        if (incoming <= existingWeight) {
          return { written: false, reason: "not_stronger_than_the_detach" };
        }
      } else if (incoming <= 0) {
        // 2b: to any other company. A row at organization_id = null is not
        // "attached somewhere weaker", it is attached nowhere, so placing them
        // is not a cross-org move and must not be measured against the
        // detaching weight. Measuring it that way is what made a detach
        // irreversible: employer_mismatch (0.8) outranked llm_verified (0.6)
        // for every company forever, and email_domain (0.95) could not rescue
        // them either because that source is only recorded for a person who
        // already has an organization. One correct rejection removed the person
        // from every user's reach, with no review queue to find them in (the
        // Confirm button needs an organizationId).
        //
        // Every source in AFFILIATION_WEIGHT is positive today, so this refuses
        // nothing. It states the rule that applies: positive evidence attaches,
        // an absence of evidence does not.
        return { written: false, reason: "no_positive_evidence" };
      }
    } else if (person.organization_id === organizationId) {
      // Case 3: same company, better (or equal) evidence for the same claim.
      if (incoming < existingWeight) {
        return { written: false, reason: "weaker_than_existing" };
      }
      if (incoming === existingWeight && existingSource) {
        return { written: false, reason: "already_recorded_at_same_strength" };
      }
    } else if (incoming <= existingWeight) {
      // Case 4: a cross-org move between two companies, which is a job change
      // or a correction of a bad stamp. STRICTLY stronger, never equal.
      //
      // This was `incoming < existingWeight` with the equal-weight guard applied
      // only to same-org writes, which meant equal evidence could reassign across
      // orgs. Since no row is backfilled, every pre-existing person is
      // organization_id-set + source-NULL, which this function scores as
      // search_stamp (0.2), so a single `rejected` verdict, also 0.2, was enough
      // to silently orphan any legacy contact. `people` is a shared pool across
      // users on an instance, so one person's search could empty someone else's
      // contact list. Two equal-confidence LLM calls would also ping-pong the
      // same contact between two companies on alternate runs.
      return { written: false, reason: "not_stronger_than_existing" };
    }
  }

  // Confidence is "how sure are we they work at organization_id". Detached,
  // there is no such claim to be confident about, and a non-zero score on a
  // null-org row would clear the send threshold for a person nobody can vouch
  // for. The displacement strength still comes from the source weight above,
  // which is what the monotonic guard reads.
  const storedConfidence = organizationId === null ? 0 : incoming;

  // The error is read, not discarded. affiliation_source carries a CHECK
  // constraint, so a value the migration has not been taught about fails every
  // write with 23514, which is exactly what happened to every detach on this
  // branch, silently, because nothing here looked.
  const { error } = await supabase
    .from("people")
    .update({
      organization_id: organizationId,
      affiliation_source: source,
      affiliation_confidence: storedConfidence,
      affiliation_evidence: evidence.slice(0, 500),
      affiliation_verified_at: new Date().toISOString(),
      // Cleared the moment they are attached to anyone. The column means "the
      // company this row was rejected from", and once they are filed somewhere
      // that is no longer what the row is about: a stale value would apply the
      // re-attachment rule above to a company nobody ever judged them against.
      affiliation_detached_from: detaching ? detachedFrom : null,
    })
    .eq("id", personId);

  if (error) {
    console.error(
      `[affiliation] write failed for person ${personId} (${source}): ${error.message}`,
    );
    return { written: false, reason: error.message };
  }

  return { written: true };
}

// ─── Send gate ────────────────────────────────────────────────────────────

/** The fields the send gate reads. */
export interface SendCandidate {
  work_email: string | null;
  /** Read only to give an accurate refusal reason, never sendable itself. */
  personal_email?: string | null;
  work_email_source: string | null;
  work_email_verification: string | null;
  affiliation_confidence: number | null;
  affiliation_source: string | null;
  /**
   * Who we believe they work for. `affiliation_confidence` is confidence in
   * *this* link; with no link there is nothing for the number to be about, and
   * a detached row carrying a high score would otherwise clear the threshold.
   */
  organization_id?: string | null;
}

export type SendCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether we know enough about a contact to email them.
 *
 * Nothing checked this before: the send path only asked whether the address
 * field was non-empty, so a blind {first}.{last}@domain guess written at
 * confidence 0.2 was treated exactly like an address the user typed in
 * themselves. Both halves of the check matter and they fail differently — a bad
 * address bounces and costs sender reputation, a bad affiliation sends a
 * personalised pitch about the wrong company to a real person.
 *
 * Returns a reason rather than a bare false so the agent can explain the
 * blockage and offer the fix, instead of silently skipping the contact.
 */
export function canSendTo(person: SendCandidate): SendCheck {
  if (!person.work_email) {
    return {
      ok: false,
      // Distinguish "nothing at all" from "only a personal address". saveDraft
      // will happily address a draft to personal_email, so the old blanket
      // "no email address on file" was factually wrong for those contacts and
      // the agent relayed it to the user as fact.
      reason: person.personal_email
        ? "only a personal address is on file; outreach requires a work address (enter one to unblock)"
        : "no email address on file",
    };
  }

  // A human typing the address outranks any machine verdict, including a
  // catch-all "risky". Without this exemption, correcting a bad address by hand
  // could not unblock a contact — and on a catch-all domain, where every
  // address verifies `risky`, nothing could ever be sent at all.
  const humanEntered = person.work_email_source === "user_entered";

  // `undeliverable` blocks unconditionally — including for user_entered.
  //
  // The human exemption must not cover this verdict: a bounce is recorded
  // about the exact string currently stored, so a hand-typed address that hard
  // bounced is a typo, and exempting it made that typo permanently sendable —
  // nothing ever displaces user_entered (1.0), and findEmail refuses to
  // re-check trusted sources. The way out is entering a *different* address,
  // which clears the verdict.
  //
  // Checked BEFORE the source shortcuts below for the same reason as ever:
  // every address that has been sent carries `send_confirmed` by definition,
  // so trusting the source first kept hard-bounced mailboxes sendable.
  if (person.work_email_verification === "undeliverable") {
    return {
      ok: false,
      reason:
        "this address hard-bounced; enter a corrected address for this contact",
    };
  }

  // `risky` is different: it usually means a catch-all domain, where EVERY
  // address verifies risky, so without a human exemption nothing at such a
  // company could ever be emailed. A person vouching for the address is the
  // one signal a catch-all cannot fake.
  if (!humanEntered && person.work_email_verification === "risky") {
    return {
      ok: false,
      reason: `email verification came back "risky", so it is not confirmed deliverable`,
    };
  }

  // A human typing the address, or a previous send it accepted, is proof enough
  // — neither needs a verifier to confirm it.
  const emailTrusted =
    person.work_email_source === "user_entered" ||
    person.work_email_source === "send_confirmed" ||
    person.work_email_verification === "deliverable";

  if (!emailTrusted) {
    const state = person.work_email_verification ?? "unchecked";
    return {
      ok: false,
      reason:
        state === "unchecked"
          ? "email has never been verified; run findEmail with an email provider configured, or enter the address manually"
          : `email verification came back "${state}", so it is not confirmed deliverable`,
    };
  }

  if (!person.organization_id) {
    return {
      ok: false,
      reason:
        "not linked to a company, and outreach personalises against the employer, so there is nothing to write about",
    };
  }

  const confidence = person.affiliation_confidence ?? 0;
  if (confidence < AFFILIATION_SEND_THRESHOLD) {
    return {
      ok: false,
      reason: person.affiliation_source
        ? `not confirmed to work at this company (evidence: ${person.affiliation_source}, confidence ${confidence.toFixed(2)})`
        : "no evidence on file that this person works at this company",
    };
  }

  return { ok: true };
}

/**
 * Draft-stage predicate: is this contact worth spending a Claude call drafting
 * for?
 *
 * Deliberately laxer than canSendTo on exactly one axis. An `unchecked` email
 * is a fine reason to draft — verification is lazy, and the send gate proves
 * the address just-in-time when the mail actually leaves. What still blocks a
 * draft: no address at all, an address already proven dead or risky, and an
 * unconfirmed employer (a personalised pitch about the wrong company is wasted
 * whichever address it goes to).
 */
export function canDraftFor(person: SendCandidate): SendCheck {
  if (!person.work_email) {
    return {
      ok: false,
      reason: person.personal_email
        ? "only a personal address is on file; outreach requires a work address"
        : "no email address on file",
    };
  }

  const humanEntered = person.work_email_source === "user_entered";
  if (person.work_email_verification === "undeliverable") {
    return { ok: false, reason: "this address hard-bounced" };
  }
  if (!humanEntered && person.work_email_verification === "risky") {
    return { ok: false, reason: "address is on a catch-all domain" };
  }

  if (!person.organization_id) {
    return {
      ok: false,
      reason:
        "not linked to a company, and outreach personalises against the employer, so there is nothing to write about",
    };
  }

  const confidence = person.affiliation_confidence ?? 0;
  if (confidence < AFFILIATION_SEND_THRESHOLD) {
    return {
      ok: false,
      reason: person.affiliation_source
        ? `not confirmed to work at this company (evidence: ${person.affiliation_source})`
        : "no evidence on file that this person works at this company",
    };
  }

  return { ok: true };
}

/** Columns canSendTo needs — keep SELECTs and the predicate in step. */
export const SEND_GATE_COLUMNS =
  "work_email, personal_email, work_email_source, work_email_verification, affiliation_confidence, affiliation_source, organization_id";

// ─── LinkedIn employer check ──────────────────────────────────────────────

export type EmployerCheck =
  | { status: "match"; employer: string }
  | { status: "mismatch"; employer: string }
  /** Rate-limited, blocked, or unparseable — tells us nothing either way. */
  | { status: "unknown"; reason: string };

/**
 * Normalize a company name for comparison: lowercase, strip common legal
 * suffixes, collapse punctuation and whitespace.
 *
 * Duplicated deliberately rather than imported from contact-filter, which owns
 * the LLM path — this is a small pure helper and importing that module would
 * drag an Anthropic client into every affiliation check.
 */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(ltd|limited|inc|incorporated|llc|plc|corp|corporation|co|company|group|holdings)\b\.?/g,
      "",
    )
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pulls the employer out of a LinkedIn profile.
 *
 * The page title is reliably "Name - Employer | LinkedIn", and og:description
 * carries "· Experience: <Employer> ·" as a fallback. Both survive the
 * logged-out view, which is the only view we get without authenticating.
 */
export function parseLinkedInEmployer(
  title: string | null | undefined,
  ogDescription?: string | null,
): string | null {
  const fromTitle = title
    ?.replace(/\s+/g, " ")
    .trim()
    .match(/^(.+?)\s+-\s+(.+?)\s*\|\s*LinkedIn/)?.[2];
  if (fromTitle) return fromTitle.trim();

  const fromDesc = ogDescription?.match(/Experience:\s*([^·]+)/i)?.[1];
  return fromDesc ? fromDesc.trim() : null;
}

/**
 * Checks a person's LinkedIn profile against the employer we have on file.
 *
 * Best-effort by design. LinkedIn rate-limits aggressively (HTTP 999) and
 * roughly half of attempts come back empty; an `unknown` result must leave the
 * existing affiliation exactly as it was. Treating a block as a mismatch would
 * unlink real employees at random.
 */
export async function checkLinkedInEmployer(
  linkedinUrl: string,
  expectedCompany: string,
): Promise<EmployerCheck> {
  // Must be the www host — the apex form redirects and our scrapers return an
  // empty body for it. Every URL stored before this fix is apex.
  const url = normalizeLinkedInUrl(linkedinUrl);

  const extractor = new WebExtractionService();
  const result = await extractor.extract(url, {
    includeMetadata: true,
    includeLinks: false,
    timeout: 10_000,
  });

  if (!result.success) {
    return { status: "unknown", reason: result.error ?? "fetch failed" };
  }

  const employer = parseLinkedInEmployer(
    result.data.title,
    result.data.openGraph?.description ?? result.data.description,
  );

  if (!employer) {
    return { status: "unknown", reason: "no employer in profile" };
  }

  const seen = normalizeCompanyName(employer);
  const expected = normalizeCompanyName(expectedCompany);
  if (!seen || !expected) {
    return { status: "unknown", reason: "unusable company name" };
  }

  // Substring either way: "Browserbase" vs "Browserbase Inc", or a headline
  // that reads "Acme (YC W24)".
  const match = seen.includes(expected) || expected.includes(seen);
  return match
    ? { status: "match", employer }
    : { status: "mismatch", employer };
}
