import { redirect } from "next/navigation";

/**
 * The deck used to live here as a prototype while the interview owned
 * /email-skills. The deck is now the only flow and lives at /email-skills;
 * this stub keeps old links (and muscle memory) working, campaign scope
 * included.
 */
export default async function VoiceSwipeRedirect({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { campaign } = await searchParams;
  redirect(
    campaign
      ? `/email-skills?campaign=${encodeURIComponent(campaign)}`
      : "/email-skills",
  );
}
