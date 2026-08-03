import { MailWarning, MessageSquareReply, Send, Users } from "lucide-react";

import { StatCard } from "@/components/ui/stat-card";

interface DashboardTotals {
  leads: number;
  sent: number;
  replied: number;
  bounced: number;
}

interface StatCardsProps {
  totals: DashboardTotals;
}

export function StatCards({ totals }: StatCardsProps) {
  const bounceRate =
    totals.sent > 0 ? Math.round((totals.bounced / totals.sent) * 100) : 0;
  const replyRate =
    totals.sent > 0 ? Math.round((totals.replied / totals.sent) * 100) : 0;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard
        label="Total Leads"
        value={totals.leads}
        accent="primary"
        icon={Users}
        className="animate-rise"
      />
      <StatCard
        label="Sent"
        value={totals.sent}
        accent="info"
        icon={Send}
        className="animate-rise [--rise-delay:60ms]"
      />
      {/* Was "Opened", which could only ever read zero: Signal sends no
          tracking pixel, so nothing writes that status. Bounced was already
          being computed by the API and rendered nowhere. */}
      <StatCard
        label="Bounced"
        value={totals.bounced}
        sublabel={totals.sent > 0 ? `${bounceRate}% bounce rate` : undefined}
        accent="warn"
        icon={MailWarning}
        className="animate-rise [--rise-delay:120ms]"
      />
      <StatCard
        label="Replied"
        value={totals.replied}
        sublabel={totals.sent > 0 ? `${replyRate}% reply rate` : undefined}
        accent="success"
        icon={MessageSquareReply}
        className="animate-rise [--rise-delay:180ms]"
      />
    </div>
  );
}
