/**
 * The one definition of "an email left for this contact".
 *
 * bounced and complained are IN. A send that bounced still left: excluding it
 * shrinks the denominator every rate is measured against, makes a bounce
 * *raise* the apparent reply rate, and made the campaign page disagree with
 * the dashboard about how many people were contacted. 'opened' survives only
 * to keep legacy rows counted: nothing writes it today (Signal sends no
 * tracking pixel).
 *
 * This list existed as four hand-copied predicates that had already drifted:
 * the dashboard had the full set, the campaign header and stats card did not.
 */
export const CONTACTED_STATUSES = [
  "sent",
  "opened",
  "replied",
  "bounced",
  "complained",
] as const;

export function isContactedStatus(status: string | null | undefined): boolean {
  return (
    status != null && (CONTACTED_STATUSES as readonly string[]).includes(status)
  );
}
