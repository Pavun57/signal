-- One-time prod data repairs unlocked by PRs #78-#82 (Wave 0 + Wave 1).
-- Run in the Supabase SQL editor for the PROD project, section by section,
-- ONLY AFTER the Vercel deploy of latest main is live (otherwise un-fixed
-- code re-corrupts these rows).
--
-- Every section: run the DRY RUN select first, sanity-check the rows, then
-- run the repair inside the transaction. Each repair reports affected rows.

-- ═══════════════════════════════════════════════════════════════════════
-- R5 (URGENT: duplicate-send risk). Drafts reset to 'draft'/'queued' that
-- already have a sent_emails row: the email was delivered; re-mark 'sent'
-- BEFORE the next send window.
-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN
SELECT d.id, d.to_email, d.status AS draft_status, se.sent_at
FROM email_drafts d JOIN sent_emails se ON se.draft_id = d.id
WHERE d.status IN ('draft', 'queued');

BEGIN;
UPDATE email_drafts d
SET status = 'sent', updated_at = now()
FROM sent_emails se
WHERE se.draft_id = d.id AND d.status IN ('draft', 'queued');
COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- R3. campaign_people downgraded replied/bounced -> sent: restore from
-- sent_emails ground truth. (Bounced first, replied last: replied wins
-- when both somehow exist.)
-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN
SELECT cp.id, cp.outreach_status, se.status AS sent_email_status
FROM campaign_people cp JOIN sent_emails se ON se.campaign_people_id = cp.id
WHERE se.status IN ('replied', 'bounced')
  AND cp.outreach_status NOT IN ('replied','bounced','complained','unsubscribed');

BEGIN;
UPDATE campaign_people cp SET outreach_status = 'bounced'
FROM sent_emails se
WHERE se.campaign_people_id = cp.id AND se.status = 'bounced'
  AND cp.outreach_status NOT IN ('replied','bounced','complained','unsubscribed');
UPDATE campaign_people cp SET outreach_status = 'replied'
FROM sent_emails se
WHERE se.campaign_people_id = cp.id AND se.status = 'replied'
  AND cp.outreach_status NOT IN ('replied','bounced','complained','unsubscribed');
COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- R7 (compliance). Suppressions lost when the upsert failed after intent
-- was stamped: rebuild from classified replies. Idempotent (conflict
-- target matches the classifier's).
-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN
SELECT r.user_id, lower(se.to_email) AS email, r.intent, r.intent_confidence
FROM email_replies r JOIN sent_emails se ON se.id = r.sent_email_id
WHERE (r.intent = 'unsubscribe'
       OR (r.intent = 'not_interested' AND r.intent_confidence >= 0.8))
  AND NOT EXISTS (
    SELECT 1 FROM outreach_suppressions s
    WHERE s.user_id = r.user_id AND s.email = lower(se.to_email));

BEGIN;
INSERT INTO outreach_suppressions (user_id, person_id, email, reason, source, detail)
SELECT r.user_id, r.person_id, lower(se.to_email),
       CASE WHEN r.intent = 'unsubscribe' THEN 'unsubscribe' ELSE 'not_interested' END,
       'classifier',
       'repair 2026-08-07: backfilled from a classified reply whose suppression upsert was lost'
FROM email_replies r JOIN sent_emails se ON se.id = r.sent_email_id
WHERE (r.intent = 'unsubscribe'
       OR (r.intent = 'not_interested' AND r.intent_confidence >= 0.8))
ON CONFLICT (user_id, email) DO NOTHING;
COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- R4. Duplicate drafts per (enrollment, step) from re-drafting: keep the
-- approved one if any, else the newest; discard the rest. Run BEFORE R1/R2
-- so resumed enrollments see exactly one draft per step.
-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN
SELECT enrollment_id, sequence_step_id, count(*) AS copies
FROM email_drafts
WHERE enrollment_id IS NOT NULL AND sequence_step_id IS NOT NULL
  AND status = 'draft'
GROUP BY 1, 2 HAVING count(*) > 1;

BEGIN;
UPDATE email_drafts SET status = 'discarded', updated_at = now()
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY enrollment_id, sequence_step_id
      ORDER BY (review_status = 'approved') DESC, created_at DESC
    ) AS rn
    FROM email_drafts
    WHERE enrollment_id IS NOT NULL AND sequence_step_id IS NOT NULL
      AND status = 'draft'
  ) ranked WHERE rn > 1
);
COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- R1. Plain-sequence enrollments stuck 'queued' (the dead status): promote
-- to 'waiting' so the followups sweep can send them once their drafts are
-- approved. Signal-triggered sequences are deliberately untouched.
-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN
SELECT e.id, s.name AS sequence_name, e.status
FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
WHERE e.status = 'queued' AND s.trigger_signal_id IS NULL;

BEGIN;
UPDATE sequence_enrollments e
SET status = 'waiting', updated_at = now()
FROM sequences s
WHERE s.id = e.sequence_id AND e.status = 'queued'
  AND s.trigger_signal_id IS NULL;
COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- R2. Enrollments pinned to a step whose draft already SENT (cleanup used
-- to stop half-way): complete the ones on their last step, advance the
-- rest (next step's delay from now), and sync campaign_people.
-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN
SELECT e.id, e.current_step, e.status
FROM sequence_enrollments e
JOIN sequence_steps st ON st.sequence_id = e.sequence_id AND st.step_number = e.current_step
JOIN email_drafts d ON d.enrollment_id = e.id AND d.sequence_step_id = st.id
WHERE e.status IN ('active', 'waiting') AND d.status = 'sent';

BEGIN;
-- last step -> completed
UPDATE sequence_enrollments e SET status = 'completed', updated_at = now()
FROM sequence_steps st, email_drafts d
WHERE st.sequence_id = e.sequence_id AND st.step_number = e.current_step
  AND d.enrollment_id = e.id AND d.sequence_step_id = st.id
  AND e.status IN ('active', 'waiting') AND d.status = 'sent'
  AND NOT EXISTS (SELECT 1 FROM sequence_steps n
                  WHERE n.sequence_id = e.sequence_id
                    AND n.step_number = e.current_step + 1);
-- has a next step -> advance onto it
UPDATE sequence_enrollments e
SET current_step = e.current_step + 1,
    status = 'active',
    next_send_at = now() + make_interval(
      days => COALESCE(n.delay_days, 0), hours => COALESCE(n.delay_hours, 0)),
    updated_at = now()
FROM sequence_steps st, email_drafts d, sequence_steps n
WHERE st.sequence_id = e.sequence_id AND st.step_number = e.current_step
  AND d.enrollment_id = e.id AND d.sequence_step_id = st.id
  AND e.status IN ('active', 'waiting') AND d.status = 'sent'
  AND n.sequence_id = e.sequence_id AND n.step_number = e.current_step + 1;
-- the contact was emailed, whatever the crash left behind
UPDATE campaign_people cp SET outreach_status = 'sent'
FROM email_drafts d
WHERE d.campaign_people_id = cp.id AND d.status = 'sent'
  AND cp.outreach_status IN ('not_contacted', 'queued');
COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- R6. Enrollments stranded by a discarded current-step draft with no live
-- replacement: complete them (matching the fixed discardDraft behavior).
-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN
SELECT e.id, e.current_step
FROM sequence_enrollments e
WHERE e.status IN ('active', 'waiting')
  AND EXISTS (SELECT 1 FROM email_drafts d
              JOIN sequence_steps st ON st.id = d.sequence_step_id
              WHERE d.enrollment_id = e.id AND st.step_number = e.current_step
                AND d.status = 'discarded')
  AND NOT EXISTS (SELECT 1 FROM email_drafts d2
                  JOIN sequence_steps st2 ON st2.id = d2.sequence_step_id
                  WHERE d2.enrollment_id = e.id AND st2.step_number = e.current_step
                    AND d2.status IN ('draft', 'queued', 'sent'));

BEGIN;
UPDATE sequence_enrollments e SET status = 'completed', updated_at = now()
WHERE e.status IN ('active', 'waiting')
  AND EXISTS (SELECT 1 FROM email_drafts d
              JOIN sequence_steps st ON st.id = d.sequence_step_id
              WHERE d.enrollment_id = e.id AND st.step_number = e.current_step
                AND d.status = 'discarded')
  AND NOT EXISTS (SELECT 1 FROM email_drafts d2
                  JOIN sequence_steps st2 ON st2.id = d2.sequence_step_id
                  WHERE d2.enrollment_id = e.id AND st2.step_number = e.current_step
                    AND d2.status IN ('draft', 'queued', 'sent'));
COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- R17. Pending drafts whose to_email fell out of sync with the contact's
-- corrected work_email (silently failed retargets): resync so the send
-- gate stops refusing them.
-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN
SELECT d.id, d.to_email AS draft_addr, p.work_email AS contact_addr
FROM email_drafts d JOIN people p ON p.id = d.person_id
WHERE d.status = 'draft' AND p.work_email IS NOT NULL
  AND lower(d.to_email) <> lower(p.work_email);

BEGIN;
UPDATE email_drafts d SET to_email = p.work_email, updated_at = now()
FROM people p
WHERE p.id = d.person_id AND d.status = 'draft'
  AND p.work_email IS NOT NULL
  AND lower(d.to_email) <> lower(p.work_email);
COMMIT;
