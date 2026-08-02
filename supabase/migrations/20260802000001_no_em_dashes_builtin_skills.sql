-- Strip em dashes from the built-in email skill instructions.
--
-- These rows are fed verbatim into the email composer's prompt, so an em dash
-- here teaches the drafting model to write them into real outbound emails.
-- Only built-in rows are touched; anything a user has authored is left alone.

update email_skills
set instructions = 'Hard limit: 3 sentences for step 1, 2 sentences for follow-ups, 1 sentence for breakup.
Cut every word that does not carry weight. No "I hope this finds you well", no "I wanted to reach out", no "just checking in".
Subject line: under 40 characters, lowercase if possible, no punctuation fluff.'
where slug = 'short-and-direct' and is_builtin = true;

update email_skills
set instructions = 'Write in first person ("I", not "we" or "our team").
Tone: warm, direct, a little informal. Contractions are fine. Starting a sentence with "And" or "But" is fine.
Mention that you are the founder/builder when it is natural; it earns trust.
Avoid: corporate pronouns, marketing taglines, anything that reads like it came from a marketing team.'
where slug = 'founder-voice' and is_builtin = true;

update email_skills
set instructions = 'HTML body should be nothing more than a few <p> tags and at most one <a> link. No <strong>, no <em>, no lists, no tables.
Prefer a calendar-link ask only when truly warranted; default to a one-line question that invites a plain reply.
Plain-text body must be a clean mirror of the HTML, readable without any rendering.'
where slug = 'plain-text-preferred' and is_builtin = true;

update email_skills
set instructions = 'Scan the enrichment for language the prospect actually uses (their LinkedIn headline, a recent post, their company''s website copy) and echo one or two of those exact phrases in your email.
This is not about flattery; it is about proving you read the source material.
Never copy a full sentence. One noun phrase or one verb is plenty.'
where slug = 'mirror-their-vocabulary' and is_builtin = true;
