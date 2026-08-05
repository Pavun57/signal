import { getAdminClient } from "@/lib/supabase/admin";
import { enqueueJob } from "@/lib/services/jobs";
import { withAction } from "@/lib/services/cost-tracker";
import { executeSignal } from "@/lib/signals/executor";
import type { Signal } from "@/lib/types/signal";
import {
  normalizeHiringData,
  buildGenericSnapshot,
  hashSnapshot,
  diffHiringSnapshots,
  classifyNewRoles,
  describeHiringChanges,
} from "@/lib/services/tracking-differ";
import type { GenericSnapshot } from "@/lib/services/tracking-differ";
import { structuralDiff } from "@/lib/signals/diff";
import type { SignalOutput } from "@/lib/signals/types";
import { evaluateIntent } from "@/lib/services/intent-evaluator";
import type { HiringSnapshot, TrackingConfig } from "@/lib/types/tracking";

/**
 * Runs one tracking config: execute its signal, snapshot, diff against the
 * previous snapshot, and fire outreach when the intent verdict says so.
 *
 * Retry safety: a retry after partial failure re-executes the signal and
 * inserts a second snapshot with the same hash, which the differ then reports
 * as "no change" — a harmless duplicate timeline row, no duplicate outreach
 * (the enqueue only fires on a fresh diff verdict).
 */
export async function runTrackingConfig(trackingConfigId: string) {
  // Load tracking config with joins
  const { data: config, error: configErr } = await getAdminClient()
    .from("tracking_configs")
    .select(
      "*, organization:organizations(*), signal:signals(*), campaign:campaigns(icp, offering, user_id)",
    )
    .eq("id", trackingConfigId)
    .single();

  if (configErr || !config) {
    throw new Error(`Tracking config not found: ${configErr?.message}`);
  }

  const typedConfig = config as TrackingConfig & {
    organization: Record<string, unknown> | null;
    signal: Record<string, unknown>;
    campaign: {
      icp: Record<string, unknown>;
      offering: Record<string, unknown>;
      user_id: string | null;
    };
  };

  const orgName =
    (typedConfig.organization?.name as string) || "Unknown Company";
  const orgDomain = typedConfig.organization?.domain as string | undefined;

  // Wrap in withAction for cost tracking
  return withAction(`Tracking run: ${orgName}`, async () => {
    // ── Execute signal via universal executor ────────────────────────
    const signalRecord = typedConfig.signal as unknown as Signal;
    let signalOutput: SignalOutput;
    let rawOutput: Record<string, unknown>;

    try {
      signalOutput = await executeSignal(signalRecord, {
        organizationId: config.organization_id,
        domain: orgDomain,
        name: orgName,
        campaignId: config.campaign_id,
        useAdmin: true,
      });

      rawOutput = signalOutput.data;

      // If the signal executor didn't find anything meaningful, still store the result
      if (!signalOutput.found && !rawOutput) {
        rawOutput = { found: false, summary: signalOutput.summary };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      throw new Error(`Signal execution failed: ${msg}`);
    }

    // ── Normalize into snapshot ────────────────────────────────────────
    // Hiring-shaped output (the hiring-activity scraper) keeps its rich
    // title-level diffing; everything else gets a stable generic snapshot.
    // Detection is on output shape, not slug, so any future signal that
    // emits { jobs: [...] } inherits the hiring pipeline.
    const isHiring = Array.isArray(rawOutput.jobs);
    const jobs = isHiring
      ? (rawOutput.jobs as Array<{
          title: string;
          department?: string;
          location?: string;
          url?: string;
        }>)
      : [];
    const careersUrl = (rawOutput.careersUrl as string) || null;
    const snapshot = isHiring
      ? normalizeHiringData(jobs, careersUrl)
      : buildGenericSnapshot(signalRecord.execution_type, rawOutput);
    const hash = hashSnapshot(snapshot);

    // ── Compare to previous snapshot ───────────────────────────────────
    const { data: prevSnapshots } = await getAdminClient()
      .from("tracking_snapshots")
      .select("snapshot_data, snapshot_hash")
      .eq("tracking_config_id", trackingConfigId)
      .order("captured_at", { ascending: false })
      .limit(1);

    const prevSnapshot = prevSnapshots?.[0] ?? null;
    const hasChanged = !prevSnapshot || prevSnapshot.snapshot_hash !== hash;

    // ── Store new snapshot (always, for the timeline) ──────────────────
    await getAdminClient().from("tracking_snapshots").insert({
      tracking_config_id: trackingConfigId,
      snapshot_data: snapshot,
      snapshot_hash: hash,
    });

    // ── Store signal_result with tracking_config_id ────────────────────
    await getAdminClient().from("signal_results").insert({
      signal_id: config.signal_id,
      campaign_id: config.campaign_id,
      organization_id: config.organization_id,
      person_id: config.person_id,
      tracking_config_id: trackingConfigId,
      output: rawOutput,
      status: "success",
    });

    // ── Update last_run_at ─────────────────────────────────────────────
    await getAdminClient()
      .from("tracking_configs")
      .update({ last_run_at: new Date().toISOString() })
      .eq("id", trackingConfigId);

    if (!hasChanged) {
      return {
        trackingConfigId,
        changed: false,
        jobCount: isHiring ? (snapshot as HiringSnapshot).job_count : undefined,
      };
    }

    // ── Compute diff ───────────────────────────────────────────────────
    const prevData = prevSnapshot ? prevSnapshot.snapshot_data : null;

    // If no previous data (first run after baseline), store as baseline
    if (!prevData) {
      return {
        trackingConfigId,
        changed: false,
        baseline: true,
        jobCount: isHiring ? (snapshot as HiringSnapshot).job_count : undefined,
      };
    }

    let changeDescription: string;
    let rawDiffForIntent: unknown;
    let diffSummary: Record<string, unknown>;

    if (isHiring) {
      const prevHiring = prevData as HiringSnapshot;
      const currHiring = snapshot as HiringSnapshot;
      const diff = diffHiringSnapshots(prevHiring, currHiring);

      // ── Classify new roles via Haiku ─────────────────────────────────
      if (diff.added_jobs.length > 0) {
        const icp = typedConfig.campaign.icp || {};
        const offering = typedConfig.campaign.offering || {};
        const icpContext = [
          icp.industry && `Industry: ${icp.industry}`,
          icp.targetTitles &&
            `Target titles: ${(icp.targetTitles as string[]).join(", ")}`,
          icp.painPoints &&
            `Pain points: ${(icp.painPoints as string[]).join(", ")}`,
          offering.description && `Offering: ${offering.description}`,
        ]
          .filter(Boolean)
          .join(". ");

        const classified = await classifyNewRoles(diff.added_jobs, icpContext);
        diff.classified_added = classified;
      }

      // ── Store tracking changes ───────────────────────────────────────
      changeDescription = describeHiringChanges(diff);

      const changesToInsert: Array<Record<string, unknown>> = [];

      if (diff.added_jobs.length > 0) {
        changesToInsert.push({
          tracking_config_id: trackingConfigId,
          change_type: "added",
          field_path: "jobs",
          previous_value: null,
          current_value: diff.added_jobs,
          description: `+${diff.added_jobs.length} role${diff.added_jobs.length > 1 ? "s" : ""}: ${diff.added_jobs.map((j) => j.title).join(", ")}`,
        });
      }

      if (diff.removed_jobs.length > 0) {
        changesToInsert.push({
          tracking_config_id: trackingConfigId,
          change_type: "removed",
          field_path: "jobs",
          previous_value: diff.removed_jobs,
          current_value: null,
          description: `-${diff.removed_jobs.length} role${diff.removed_jobs.length > 1 ? "s" : ""}: ${diff.removed_jobs.map((j) => j.title).join(", ")}`,
        });
      }

      if (diff.job_count_delta !== 0 && changesToInsert.length === 0) {
        changesToInsert.push({
          tracking_config_id: trackingConfigId,
          change_type: "count_change",
          field_path: "job_count",
          previous_value: prevHiring.job_count,
          current_value: currHiring.job_count,
          description: changeDescription,
        });
      }

      if (changesToInsert.length > 0) {
        await getAdminClient().from("tracking_changes").insert(changesToInsert);
      }

      rawDiffForIntent = diff;
      diffSummary = {
        addedCount: diff.added_jobs.length,
        removedCount: diff.removed_jobs.length,
        jobCountDelta: diff.job_count_delta,
        description: changeDescription,
      };
    } else {
      const prevGeneric = prevData as GenericSnapshot;
      const currGeneric = snapshot as GenericSnapshot;
      // Prefer the executor's own diff (exa_search and recipes compute one
      // against signal_results); fall back to a structural diff of snapshots.
      const executorDiff = signalOutput.diff;
      const structural = structuralDiff(prevGeneric.data, currGeneric.data);
      const meaningful = executorDiff?.changed ?? structural.changed;
      if (!meaningful) {
        // Hash moved but nothing semantically changed (e.g. result
        // reordering a projection didn't catch). Don't wake the intent
        // evaluator.
        return { trackingConfigId, changed: false };
      }

      changeDescription =
        executorDiff?.description ||
        structural.description ||
        "Signal output changed";
      rawDiffForIntent = executorDiff ?? structural;

      // ── Store tracking change ────────────────────────────────────────
      await getAdminClient().from("tracking_changes").insert({
        tracking_config_id: trackingConfigId,
        change_type: "added",
        field_path: "data",
        previous_value: prevGeneric.data,
        current_value: currGeneric.data,
        description: changeDescription,
      });

      diffSummary = { description: changeDescription };
    }

    // ── Evaluate intent via LLM ────────────────────────────────────────
    const signal = typedConfig.signal as {
      name?: string;
      category?: string;
    } | null;
    const verdict = await evaluateIntent({
      intent: (typedConfig.intent as string) ?? "",
      signalName: signal?.name ?? "Unknown signal",
      signalCategory: signal?.category ?? "custom",
      snapshotSummary: changeDescription,
      rawDiff: rawDiffForIntent,
      isFirstRun: false,
    });

    if (verdict.fire) {
      await getAdminClient()
        .from("tracking_changes")
        .insert({
          tracking_config_id: trackingConfigId,
          change_type: "threshold_crossed",
          field_path: null,
          previous_value: null,
          current_value: { confidence: verdict.confidence },
          description: verdict.reason,
        });

      const junctionTable = config.organization_id
        ? "campaign_organizations"
        : "campaign_people";
      const entityField = config.organization_id
        ? "organization_id"
        : "person_id";
      const entityId = config.organization_id || config.person_id;

      await getAdminClient()
        .from(junctionTable)
        .update({ readiness_tag: "ready_to_contact" })
        .eq("campaign_id", config.campaign_id)
        .eq(entityField, entityId);

      // Auto-send only when the config explicitly opted in AND the intent
      // verdict is high-confidence — both required, everything else stays
      // in the human review queue.
      const autoSend =
        Boolean(typedConfig.auto_send) && verdict.confidence === "high";

      // Enqueue the outreach job; /api/jobs/* auth guards the outbox path.
      // Fire-and-forget: don't block the tracking run on the dispatch.
      void enqueueJob({
        type: "outreach.process",
        payload: {
          type: "signal",
          signalId: config.signal_id,
          campaignId: config.campaign_id,
          organizationId: config.organization_id ?? undefined,
          reason: verdict.reason,
          confidence: verdict.confidence,
          autoSend,
        },
        // Queue fairness: attribute the outreach job to the campaign owner
        // instead of the shared '<system>' partition.
        userId: typedConfig.campaign.user_id ?? null,
      }).catch((err) => {
        console.error("[tracking] Failed to enqueue outreach:", err);
      });
    }

    return {
      trackingConfigId,
      changed: true,
      diff: diffSummary,
      intentFired: verdict.fire,
      reason: verdict.reason,
      confidence: verdict.confidence,
    };
  });
}
