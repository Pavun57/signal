import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { llmTimeout } from "@/lib/utils/timeout";
import { apiSafeSchema } from "@/lib/ai/api-safe-schema";
import { MODELS } from "@/lib/ai/models";
import {
  estimateClaudeCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import {
  UNTRUSTED_NOTICE,
  stringify,
  wrapUntrusted,
} from "@/lib/prompt-safety";
import { CLAIM_TYPES, type CompanyClaim } from "@/lib/types/claims";

interface EnrichmentSearch {
  category: string;
  query: string;
  results: Array<{
    title: string;
    url: string;
    publishedDate: string | null;
    text: string | null;
  }>;
}

interface ExtractInput {
  companyName: string;
  companyDomain: string | null;
  websiteContent: string | null;
  searches: EnrichmentSearch[];
}

/**
 * One Haiku pass over the raw enrichment pulls that emits typed, sourced
 * claims. The model references sources by index; the code resolves the
 * index back to the URL so a claim can never cite a URL the pull did not
 * contain. Fails open to [] so enrichment still stores raw data when the
 * extractor is down.
 */
export async function extractClaims(
  input: ExtractInput,
): Promise<CompanyClaim[]> {
  const sources: Array<{ url: string; publishedDate: string | null }> = [];
  const sourceBlocks: string[] = [];

  if (input.websiteContent && input.companyDomain) {
    sources.push({
      url: `https://${input.companyDomain}`,
      publishedDate: null,
    });
    sourceBlocks.push(
      `[0] Company website (${input.companyDomain}):\n${input.websiteContent.slice(0, 1500)}`,
    );
  }
  for (const search of input.searches) {
    for (const r of search.results) {
      const i = sources.length;
      sources.push({ url: r.url, publishedDate: r.publishedDate });
      sourceBlocks.push(
        `[${i}] (${search.category}) "${r.title}" ${r.url}${r.publishedDate ? ` published ${r.publishedDate}` : " (undated)"}\n${r.text?.slice(0, 1200) ?? ""}`,
      );
    }
  }
  if (sources.length === 0) return [];

  try {
    const { object, usage } = await generateObject({
      abortSignal: llmTimeout(),
      model: anthropic(MODELS.LIGHT),
      schema: apiSafeSchema(
        z.object({
          claims: z.array(
            z.object({
              type: z.enum(CLAIM_TYPES),
              statement: z
                .string()
                .describe("One factual sentence about the company"),
              sourceIndex: z
                .number()
                .int()
                .describe("Index of the source block the claim comes from"),
              publishedDate: z
                .string()
                .nullable()
                .describe(
                  "Date of the underlying fact if the source states one",
                ),
              // No .min/.max here: Zod range checks compile to JSON Schema
              // minimum/maximum, which Anthropic structured outputs reject
              // with a 400 for number types. Range lives in prose; the value
              // is clamped after parsing.
              confidence: z
                .number()
                .describe("Confidence in the claim, 0 to 1"),
            }),
          ),
        }),
      ),
      prompt: `You extract factual claims about a company from research sources.

${UNTRUSTED_NOTICE}

Target company: ${stringify(input.companyName)}${input.companyDomain ? ` (${stringify(input.companyDomain)})` : ""}

Extract every distinct factual claim about THIS company from the sources below. Claims must be things a salesperson would act on: funding rounds, headcount, roles being hired, executive changes, product facts, locations. Rules:
- One claim per fact. Do not merge facts from different sources into one claim.
- If two sources disagree (e.g. Series A vs Series B), emit BOTH claims, each citing its own source. Reconciliation happens downstream.
- Never invent a date. Use the source's published date only when the source states when the fact happened.
- Skip claims about other companies, even similarly named ones.

Sources:
${wrapUntrusted(sourceBlocks.join("\n\n"))}`,
    });

    trackUsage({
      service: "claude",
      operation: "claim-extractor",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateClaudeCostFromUsage("haiku", usage),
      metadata: {
        model: "claude-haiku-4-5",
        companyName: input.companyName,
        sourceCount: sources.length,
        claimCount: object.claims.length,
      },
    });

    const extractedAt = new Date().toISOString();
    return object.claims
      .filter((c) => c.sourceIndex >= 0 && c.sourceIndex < sources.length)
      .map((c) => ({
        type: c.type,
        statement: c.statement,
        sourceUrl: sources[c.sourceIndex].url,
        publishedDate: c.publishedDate ?? sources[c.sourceIndex].publishedDate,
        confidence: Math.min(1, Math.max(0, c.confidence)),
        extractedAt,
        status: "unverified" as const,
      }));
  } catch (err) {
    console.error("[claim-extractor] failed, storing raw data only:", err);
    return [];
  }
}
