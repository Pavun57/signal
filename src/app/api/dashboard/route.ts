import { getSupabaseAndUser } from "@/lib/supabase/server";
import { CONTACTED_STATUSES, isContactedStatus } from "@/lib/outreach-status";

/**
 * Dashboard aggregates.
 *
 * There is deliberately no "opened" metric. Signal sends no tracking pixel, so
 * nothing anywhere writes outreach_status = 'opened' -- which meant the old
 * opened bucket ('opened' OR 'replied') was exactly equal to replied, and the
 * dashboard showed the same number twice under two labels, one of them a
 * metric the product does not collect. 'opened' survives only inside the
 * membership tests below, where it keeps legacy rows counted as sent.
 */

export async function GET(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase } = ctx;

  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range") || "30d";

  // Calculate date filter for time-series
  let dateFilter: string | null = null;
  if (range === "7d") {
    dateFilter = new Date(Date.now() - 7 * 86400000).toISOString();
  } else if (range === "30d") {
    dateFilter = new Date(Date.now() - 30 * 86400000).toISOString();
  }

  // Run all queries in parallel -- use count queries instead of fetching rows
  const [
    leadsRes,
    sentRes,
    repliedRes,
    bouncedRes,
    timeSeriesRes,
    campaignsRes,
    allPeopleRes,
  ] = await Promise.all([
    // Aggregate totals via count queries (no row limit issues)
    supabase
      .from("campaign_people")
      .select("*", { count: "exact", head: true }),
    supabase
      .from("campaign_people")
      .select("*", { count: "exact", head: true })
      // A send that bounced still left. Excluding it shrank the denominator
      // every rate is measured against, and would have made the new bounce
      // card move the wrong way.
      .in("outreach_status", [...CONTACTED_STATUSES]),
    supabase
      .from("campaign_people")
      .select("*", { count: "exact", head: true })
      .eq("outreach_status", "replied"),
    supabase
      .from("campaign_people")
      .select("*", { count: "exact", head: true })
      .eq("outreach_status", "bounced"),

    // Time-series from outreach_events (capped to prevent memory issues).
    // Descending, so when the window holds more rows than the cap the cap
    // truncates the OLDEST days: ascending kept the head and silently dropped
    // the most recent days from the chart, and with range=all froze it at the
    // first 10000 events ever. The grouping below is order-independent and
    // the output is re-sorted ascending.
    dateFilter
      ? supabase
          .from("outreach_events")
          .select("status, created_at")
          .gte("created_at", dateFilter)
          .order("created_at", { ascending: false })
          .limit(10000)
      : supabase
          .from("outreach_events")
          .select("status, created_at")
          .order("created_at", { ascending: false })
          .limit(10000),

    // Campaign list
    supabase.from("campaigns").select("id, name, status"),

    // All campaign_people with campaign_id + status for per-campaign aggregation (single query)
    supabase
      .from("campaign_people")
      .select("campaign_id, outreach_status")
      .limit(10000),
  ]);

  // A failed query is not a zero. `count ?? 0` rendered every failure as an
  // empty-but-healthy dashboard, which is the K22 class this route sat in.
  const failed = [
    leadsRes,
    sentRes,
    repliedRes,
    bouncedRes,
    timeSeriesRes,
    campaignsRes,
    allPeopleRes,
  ].find((r) => r.error);
  if (failed?.error) {
    console.error("[dashboard] query failed:", failed.error.message);
    return Response.json(
      { error: `Dashboard query failed: ${failed.error.message}` },
      { status: 500 },
    );
  }

  const totals = {
    leads: leadsRes.count ?? 0,
    sent: sentRes.count ?? 0,
    replied: repliedRes.count ?? 0,
    bounced: bouncedRes.count ?? 0,
  };

  // Process time-series: group by day + status
  const eventsByDay = new Map<string, Record<string, number>>();
  for (const event of timeSeriesRes.data ?? []) {
    const day = event.created_at.slice(0, 10);
    if (!eventsByDay.has(day)) {
      eventsByDay.set(day, { sent: 0, replied: 0, bounced: 0 });
    }
    const bucket = eventsByDay.get(day)!;
    if (bucket[event.status] !== undefined) {
      bucket[event.status]++;
    }
  }
  const timeSeries = Array.from(eventsByDay.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Aggregate per-campaign from the single query (no N+1)
  const campaignPeople = allPeopleRes.data ?? [];
  const campaignMap = new Map<
    string,
    { leads: number; sent: number; replied: number }
  >();

  for (const row of campaignPeople) {
    if (!campaignMap.has(row.campaign_id)) {
      campaignMap.set(row.campaign_id, { leads: 0, sent: 0, replied: 0 });
    }
    const stats = campaignMap.get(row.campaign_id)!;
    stats.leads++;
    if (isContactedStatus(row.outreach_status)) stats.sent++;
    if (row.outreach_status === "replied") stats.replied++;
  }

  const campaigns = (campaignsRes.data ?? [])
    .map((c) => {
      const stats = campaignMap.get(c.id) ?? { leads: 0, sent: 0, replied: 0 };
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        leads: stats.leads,
        sent: stats.sent,
        replied: stats.replied,
        replyRate:
          stats.sent > 0 ? Math.round((stats.replied / stats.sent) * 100) : 0,
      };
    })
    .sort((a, b) => b.replyRate - a.replyRate);

  return Response.json({ totals, timeSeries, campaigns });
}
