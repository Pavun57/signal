import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { apiSafeJsonSchema } from "@/lib/ai/api-safe-schema";
import { MODELS } from "@/lib/ai/models";
import { createClient } from "@/lib/supabase/server";
import { withTimeout } from "@/lib/utils/timeout";
import { structuralDiff } from "./diff";
import { llmTimeout } from "@/lib/utils/timeout";
import {
  estimateClaudeCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import { jsonSchemaToZod } from "./json-schema-to-zod";
import { resolveArgs, resolvePath, renderTemplate } from "./paths";

const STAGEHAND_INIT_TIMEOUT_MS = 60_000;
import type {
  RecipeContext,
  RecipeStep,
  SignalEvidence,
  SignalOutput,
  SignalRecipe,
  StepResults,
} from "./types";

export interface RunRecipeOptions {
  recipe: SignalRecipe;
  context: RecipeContext;
  supabaseClient?: Awaited<ReturnType<typeof createClient>>;
  onStep?: (step: RecipeStep, result: unknown) => void;
}

export async function runRecipe(
  options: RunRecipeOptions,
): Promise<{ output: SignalOutput; steps: StepResults }> {
  const { recipe, context, onStep } = options;
  const supabase = options.supabaseClient ?? (await createClient());
  const steps: StepResults = {};
  const scope = buildScope(context, steps);

  for (const step of recipe.steps) {
    const result = await executeStep(step, scope, {
      signalId: context.signalId,
      organizationId: context.organizationId,
      campaignId: context.campaignId,
      supabase,
    });
    steps[step.id] = result;
    onStep?.(step, result);
  }

  const output = buildOutput(recipe, scope);
  return { output, steps };
}

function buildScope(
  context: RecipeContext,
  steps: StepResults,
): Record<string, unknown> {
  return { context, ...steps };
}

async function executeStep(
  step: RecipeStep,
  scope: Record<string, unknown>,
  env: {
    signalId: string;
    organizationId: string;
    campaignId: string;
    supabase: Awaited<ReturnType<typeof createClient>>;
  },
): Promise<unknown> {
  switch (step.kind) {
    case "tool": {
      // Lazy-import to break the tools/index.ts <-> signal-tools.ts cycle:
      // signal-tools imports runner; if runner statically imports
      // tool-registry (which imports allTools from tools/index), Vitest's
      // module-init order leaves some tool exports as `undefined` and
      // crashes withTelemetry. The runtime call path is far past init, so
      // a dynamic import here resolves cleanly.
      const { getRecipeTool } = await import("./tool-registry");
      const tool = getRecipeTool(step.tool);
      const args = resolveArgs(step.args, scope);
      if (!tool.execute) {
        throw new Error(`Tool "${step.tool}" has no execute function`);
      }
      try {
        const result = await tool.execute(args, {
          toolCallId: `recipe-${step.id}`,
          messages: [],
        });
        return result;
      } catch (err) {
        if (step.onError === "skip") {
          return { error: String(err) };
        }
        throw err;
      }
    }
    case "stagehand": {
      const url = resolveArgs({ url: step.url }, scope).url as string;
      const apiKey = process.env.BROWSERBASE_API_KEY;
      const projectId = process.env.BROWSERBASE_PROJECT_ID;
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || !projectId || !anthropicKey) {
        const missing = [
          !apiKey && "BROWSERBASE_API_KEY",
          !projectId && "BROWSERBASE_PROJECT_ID",
          !anthropicKey && "ANTHROPIC_API_KEY",
        ]
          .filter(Boolean)
          .join(", ");
        throw new Error(`Stagehand step missing required env vars: ${missing}`);
      }
      const { Stagehand } = await import("@browserbasehq/stagehand");
      const stagehand = new Stagehand({
        env: "BROWSERBASE",
        apiKey,
        projectId,
        model: {
          modelName: step.model ?? `anthropic/${MODELS.BROWSER}`,
          apiKey: anthropicKey,
        },
        disablePino: true,
      });
      try {
        await withTimeout(
          stagehand.init(),
          STAGEHAND_INIT_TIMEOUT_MS,
          "stagehand.init (signals-runner)",
        );
        const page = stagehand.context.pages()[0];
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeoutMs: 30000,
        });
        for (const action of step.actions ?? []) {
          if (action.op === "act") {
            const instruction = renderTemplate(action.instruction, scope);
            await stagehand.act(instruction);
          } else if (action.op === "waitMs") {
            await page.waitForTimeout(action.ms);
          }
        }
        const zodSchema = jsonSchemaToZod(step.extract.schema);
        const extracted = await stagehand.extract(
          renderTemplate(step.extract.instruction, scope),
          zodSchema,
        );
        return { url: page.url(), extracted };
      } finally {
        try {
          await stagehand.close();
        } catch {
          // ignore
        }
      }
    }
    case "history": {
      if (!isUuid(env.signalId) || !isUuid(env.organizationId)) {
        return { present: false, value: null, reason: "dryrun" };
      }
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - (step.maxAgeDays ?? 90));
      // Campaign-scoped: builtin signals are shared rows and organizations
      // are a global pool, so signal + org alone could match another
      // tenant's result under the admin client.
      let historyQuery = env.supabase
        .from("signal_results")
        .select("output, ran_at")
        .eq("signal_id", env.signalId)
        .eq("organization_id", env.organizationId);
      if (isUuid(env.campaignId)) {
        historyQuery = historyQuery.eq("campaign_id", env.campaignId);
      }
      const { data, error } = await historyQuery
        .gte("ran_at", cutoff.toISOString())
        .order("ran_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      // A failed read is not "no baseline": that lie becomes a fabricated
      // first-observation diff downstream.
      if (error) {
        return { present: false, value: null, reason: "history read failed" };
      }
      if (!data) return { present: false, value: null };
      const output = data.output as Record<string, unknown>;
      // Writers store the data payload directly; some legacy rows carry a
      // full SignalOutput wrapper, and older recipe paths address the
      // payload as "data.x". Try the row as-is, then wrapped.
      const value = step.path
        ? (resolvePath(output, step.path) ??
          resolvePath({ data: output }, step.path))
        : output;
      return { present: true, value, ran_at: data.ran_at };
    }
    case "diff": {
      const baseline = resolvePath(scope, step.baseline);
      const current = resolvePath(scope, step.current);
      return structuralDiff(baseline, current, step.keyBy);
    }
    case "extract_json": {
      const source = resolvePath(scope, step.from);
      if (typeof source !== "string" || !source.trim()) {
        return null;
      }
      // llmTimeout + trackUsage, matching every other generateObject site:
      // this was the one call that could hang a tracking run indefinitely
      // and whose spend was invisible in the cost center.
      const { object, usage } = await generateObject({
        abortSignal: llmTimeout(),
        model: anthropic(step.model ?? MODELS.LIGHT),
        schema: apiSafeJsonSchema(step.schema),
        prompt: `${step.prompt}\n\n---\n\n${source.slice(0, 30_000)}`,
      });
      trackUsage({
        service: "claude",
        operation: "signal-extract-json",
        tokens_input: usage.inputTokens ?? 0,
        tokens_output: usage.outputTokens ?? 0,
        // step.model overrides are rare; the light tier is the default and
        // close enough for attribution.
        estimated_cost_usd: estimateClaudeCostFromUsage("haiku", usage),
        metadata: { signalId: env.signalId, step: step.id },
      });
      return object;
    }
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function buildOutput(
  recipe: SignalRecipe,
  scope: Record<string, unknown>,
): SignalOutput {
  const spec = recipe.output;
  const foundRaw = resolvePath(scope, spec.foundPath);
  const found = !!foundRaw;
  const summary = renderTemplate(spec.summaryTemplate, scope).trim();
  const evidence: SignalEvidence[] = [];
  for (const ev of spec.evidence) {
    const url = resolvePath(scope, ev.urlPath);
    const snippet = resolvePath(scope, ev.snippetPath);
    if (typeof url === "string" && url) {
      evidence.push({
        url,
        snippet:
          typeof snippet === "string"
            ? snippet.slice(0, 280)
            : snippet == null
              ? ""
              : JSON.stringify(snippet).slice(0, 280),
      });
    }
  }
  const data = spec.dataPath
    ? ((resolvePath(scope, spec.dataPath) as
        | Record<string, unknown>
        | undefined) ?? {})
    : {};
  const diff = spec.diffPath
    ? (resolvePath(scope, spec.diffPath) as SignalOutput["diff"])
    : undefined;
  return {
    found,
    summary: summary || (found ? "Signal fired." : "No match."),
    evidence,
    data,
    diff,
    confidence: spec.confidence ?? "medium",
  };
}
