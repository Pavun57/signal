import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import {
  verifyQStashSignature,
  getQStashClient,
  getBaseUrl,
} from "@/lib/services/qstash";
import { withAction } from "@/lib/services/cost-tracker";
import { enrichAndFindContacts } from "@/lib/services/company-enrichment";

// Enrichment is ~1 min/company (website extraction + Exa + summarization),
// so give each hop real headroom for its small batch.
export const maxDuration = 120;

/**
 * Keep hops small: two accounts per invocation stays comfortably inside
 * maxDuration and the chain re-publishes itself until the list drains.
 */
const BATCH_PER_INVOCATION = 2;

/**
 * Target-list enrichment processor — one hop of a self-draining QStash chain.
 * The enrichTargetAccounts tool stamps target_accounts.enrich_requested_at
 * and publishes one message here; each hop enriches a small batch and
 * re-publishes the same payload while stamped, still-pending work remains.
 *
 * The route is public (QStash can't send Clerk cookies), so the signature
 * check is the only auth — everything below runs on the admin client.
 */

interface ProcessPayload {
  listId: string;
  campaignId: string;
  userId: string;
  skipContactFinding?: boolean;
}

export interface EnrichBatchItem {
  organizationId: string;
  orgName: string;
}

/**
 * Next batch of work: stamped rows whose org is still enrichment-pending,
 * oldest request first. The join filter means orgs already enriched via the
 * shared pool drain from the queue instantly, without spend — desired.
 */
export async function pickEnrichBatch(
  supabase: SupabaseClient,
  listId: string,
  n: number,
): Promise<EnrichBatchItem[]> {
  const { data, error } = await supabase
    .from("target_accounts")
    .select("organization_id, organizations!inner(name, enrichment_status)")
    .eq("list_id", listId)
    .not("enrich_requested_at", "is", null)
    .eq("organizations.enrichment_status", "pending")
    .order("enrich_requested_at", { ascending: true })
    .limit(n);
  if (error) {
    throw new Error(`Failed to pick enrichment batch: ${error.message}`);
  }
  return (data ?? []).map((row: Record<string, unknown>) => {
    const org = row.organizations as { name: string } | null;
    return {
      organizationId: row.organization_id as string,
      orgName: org?.name ?? "(unknown)",
    };
  });
}

/** Same filters as the picker, count only — decides whether to chain on. */
export async function countRemaining(
  supabase: SupabaseClient,
  listId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("target_accounts")
    .select("organization_id, organizations!inner(enrichment_status)", {
      count: "exact",
      head: true,
    })
    .eq("list_id", listId)
    .not("enrich_requested_at", "is", null)
    .eq("organizations.enrichment_status", "pending");
  if (error) {
    throw new Error(`Failed to count remaining work: ${error.message}`);
  }
  return count ?? 0;
}

export async function POST(request: Request) {
  let payload: ProcessPayload | null;
  try {
    payload = await verifyQStashSignature<ProcessPayload>(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json({ error: msg }, { status: 401 });
  }
  if (!payload) {
    return NextResponse.json({ error: "Missing payload" }, { status: 400 });
  }

  const supabase = getAdminClient();
  const body = payload;

  const work = await pickEnrichBatch(
    supabase,
    body.listId,
    BATCH_PER_INVOCATION,
  );

  for (const account of work) {
    try {
      await withAction(`Enrich target account: ${account.orgName}`, () =>
        enrichAndFindContacts(
          supabase,
          account.organizationId,
          body.campaignId,
          {
            skipContactFinding: body.skipContactFinding ?? false,
          },
        ),
      );
    } catch (err) {
      console.error(
        `[target-lists/process] enrich failed for org ${account.organizationId}:`,
        err,
      );
      // Org enrichment_status stays 'pending'/'failed'; do not retry here —
      // clear enrich_requested_at so the chain can't loop on a poison row.
      await supabase
        .from("target_accounts")
        .update({ enrich_requested_at: null })
        .eq("list_id", body.listId)
        .eq("organization_id", account.organizationId);
    }
  }

  const remaining = await countRemaining(supabase, body.listId);
  if (remaining > 0) {
    await getQStashClient().publishJSON({
      url: getBaseUrl() + "/api/target-lists/process",
      body,
    });
  }

  return NextResponse.json({ processed: work.length, remaining });
}
