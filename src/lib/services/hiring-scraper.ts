import * as cheerio from "cheerio";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { apiSafeSchema } from "@/lib/ai/api-safe-schema";
import { MODELS } from "@/lib/ai/models";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { readBodyCapped, safeFetch } from "@/lib/safe-fetch";
import {
  UNTRUSTED_NOTICE,
  stringify,
  wrapUntrusted,
} from "@/lib/prompt-safety";
import {
  estimateClaudeCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import { mergeEnrichmentData } from "@/lib/services/knowledge-base";
import { WebExtractionService } from "@/lib/services/web-extraction-service";
import { llmTimeout, withTimeout } from "@/lib/utils/timeout";

const STAGEHAND_INIT_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const PAGE_FETCH_TIMEOUT_MS = 15_000;
const ATS_API_TIMEOUT_MS = 15_000;

/** Below this many chars of extracted text, assume the page is JS-rendered. */
const THIN_CONTENT_CHARS = 200;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const COMMON_CAREERS_PATHS = [
  "/careers",
  "/jobs",
  "/hiring",
  "/work-with-us",
  "/join-us",
  "/about/careers",
  "/company/careers",
];

/**
 * Ceiling for the careers-page scrape when it runs inside an enrichment's
 * parallel pull batch alongside website extraction (~120s worst case), so
 * the whole parallel phase stays bounded. withTimeout does not cancel the
 * underlying scrape; a slow scrape may still finish and merge hiring data
 * into the DB later, it just misses that enrichment's claims.
 */
export const HIRING_SCRAPE_TIMEOUT_MS = 90_000;

export interface HiringScrapeResult {
  careersUrl: string | null;
  jobs: Array<{
    title: string;
    department?: string;
    location?: string;
    url?: string;
  }>;
  totalJobs: number;
}

type Job = HiringScrapeResult["jobs"][number];

/**
 * Scrape a company's careers page, cheapest method first:
 *
 * 1. Find the careers URL with plain fetch: probe common paths, then scan
 *    homepage links. No browser, no LLM.
 * 2. ATS shortcut: if the careers page (or homepage) links to a hosted
 *    board (Greenhouse, Lever, Ashby, Workable), hit the board's public
 *    JSON API for structured listings. Zero LLM tokens.
 * 3. Fetched-HTML extraction: WebExtractionService on the careers URL plus
 *    one Haiku pass to pull job titles out of the text.
 * 4. Full Stagehand browser session (Browserbase) only as the last resort,
 *    when no careers URL was found or the fetched content is too thin.
 *
 * Saves the hiring data to the organization's enrichment_data. Used by both
 * the `scrapeJobListings` agent tool and the tracking run route.
 */
export async function scrapeHiringData(
  organizationId: string,
  domain: string,
  maxJobs: number = 20,
): Promise<HiringScrapeResult> {
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  // Tier 1: locate the careers page without a browser.
  const { careersUrl, careersHtml, homepageHtml } =
    await findCareersPage(cleanDomain);

  // Tier 2: hosted ATS board JSON API, zero LLM.
  const board =
    detectAtsBoard(careersUrl ?? "") ??
    detectAtsBoard(careersHtml ?? "") ??
    detectAtsBoard(homepageHtml ?? "");
  if (board) {
    const atsJobs = await fetchAtsJobs(board);
    if (atsJobs !== null) {
      const url = careersUrl ?? board.boardUrl;
      const trimmed = atsJobs.slice(0, maxJobs);
      await saveHiring(organizationId, url, trimmed);
      return { careersUrl: url, jobs: trimmed, totalJobs: atsJobs.length };
    }
  }

  // Tier 3: fetch the careers page and run one Haiku extraction pass.
  if (careersUrl) {
    const extraction = await new WebExtractionService()
      .extract(careersUrl, { includeMetadata: false })
      .catch(() => null);
    const content = extraction?.success ? extraction.data.content : "";
    if (content.length >= THIN_CONTENT_CHARS) {
      const jobs = await extractJobsFromText(careersUrl, content, maxJobs);
      if (jobs !== null) {
        const trimmed = jobs.slice(0, maxJobs);
        await saveHiring(organizationId, careersUrl, trimmed);
        return { careersUrl, jobs: trimmed, totalJobs: jobs.length };
      }
    }
  }

  // Tier 4: full browser session, the old path, now the exception.
  return scrapeHiringDataWithBrowser(organizationId, cleanDomain, maxJobs);
}

/**
 * Fail-open variant for use inside enrichment: a scrape failure returns
 * null (raw enrichment proceeds without hiring data) instead of failing
 * the whole company. The raw scrapeHiringData stays throwing for the
 * agent tools, which surface errors to the model.
 */
export async function tryScrapeHiringData(
  organizationId: string,
  domain: string,
): Promise<HiringScrapeResult | null> {
  try {
    return await scrapeHiringData(organizationId, domain);
  } catch (err) {
    console.error(`[hiring-scraper] scrape failed for ${domain}:`, err);
    return null;
  }
}

async function saveHiring(
  organizationId: string,
  careersUrl: string | null,
  jobs: Job[],
): Promise<void> {
  await mergeEnrichmentData("organizations", organizationId, {
    hiring: { careersUrl, jobs, scrapedAt: new Date().toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Tier 1: careers URL discovery via plain fetch
// ---------------------------------------------------------------------------

async function findCareersPage(cleanDomain: string): Promise<{
  careersUrl: string | null;
  careersHtml: string | null;
  homepageHtml: string | null;
}> {
  // Probe the common paths and accept the first 2xx.
  for (const path of COMMON_CAREERS_PATHS) {
    const probeUrl = `https://${cleanDomain}${path}`;
    try {
      const res = await safeFetch(
        probeUrl,
        { headers: BROWSER_HEADERS },
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      if (res.ok) {
        return {
          careersUrl: res.url || probeUrl,
          careersHtml: await readBodyCapped(res).catch(() => null),
          homepageHtml: null,
        };
      }
    } catch {
      continue;
    }
  }

  // No path hit: fetch the homepage and look for a careers link.
  let homepageHtml: string | null = null;
  try {
    const res = await safeFetch(
      `https://${cleanDomain}`,
      { headers: BROWSER_HEADERS },
      { timeoutMs: PAGE_FETCH_TIMEOUT_MS },
    );
    if (res.ok) homepageHtml = await readBodyCapped(res);
  } catch {
    homepageHtml = null;
  }

  if (homepageHtml) {
    const link = findCareersLink(homepageHtml, `https://${cleanDomain}`);
    if (link) {
      try {
        // `link` came out of the HTML of a page we just fetched, so the
        // remote host chose it. It gets the same vetting as any other URL.
        const res = await safeFetch(
          link,
          { headers: BROWSER_HEADERS },
          { timeoutMs: PAGE_FETCH_TIMEOUT_MS },
        );
        if (res.ok) {
          return {
            careersUrl: res.url || link,
            careersHtml: await readBodyCapped(res).catch(() => null),
            homepageHtml,
          };
        }
      } catch {
        // fall through with the link itself; ATS detection may still match it
      }
      return { careersUrl: link, careersHtml: null, homepageHtml };
    }
  }

  return { careersUrl: null, careersHtml: null, homepageHtml };
}

const CAREERS_HREF_PATTERN =
  /(^|\/)(careers?|jobs|hiring|join-?us|work-?with-?us|open-?(positions|roles))(\/|$|\?|#)/i;
const CAREERS_TEXT_PATTERN =
  /^(careers?|jobs|we'?re hiring|hiring|join (us|the team)|work with us|open (positions|roles))$/i;

function findCareersLink(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  let found: string | null = null;
  $("a[href]").each((_, el) => {
    if (found) return;
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().trim();
    if (!CAREERS_HREF_PATTERN.test(href) && !CAREERS_TEXT_PATTERN.test(text)) {
      return;
    }
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        found = resolved.toString();
      }
    } catch {
      // ignore unresolvable hrefs
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Tier 2: hosted ATS board JSON APIs (no LLM)
// ---------------------------------------------------------------------------

type AtsProvider = "greenhouse" | "lever" | "ashby" | "workable";

interface AtsBoard {
  provider: AtsProvider;
  slug: string;
  boardUrl: string;
}

/**
 * Detect a hosted-board link anywhere in the given text (a URL or raw HTML)
 * and pull out the account slug. Regex over the raw string on purpose: it
 * catches board URLs inside embed scripts and JSON blobs, not just anchors.
 * EU-hosted Greenhouse/Lever boards use different API hosts that are not
 * verified here, so they intentionally do not match and fall to tier 3.
 */
function detectAtsBoard(text: string): AtsBoard | null {
  if (!text) return null;

  const greenhouseEmbed = text.match(
    /boards\.greenhouse\.io\/embed\/job_board\?for=([A-Za-z0-9_-]+)/i,
  );
  if (greenhouseEmbed) {
    return {
      provider: "greenhouse",
      slug: greenhouseEmbed[1],
      boardUrl: `https://boards.greenhouse.io/${greenhouseEmbed[1]}`,
    };
  }
  const greenhouse = text.match(
    /(?:job-boards|boards)\.greenhouse\.io\/([A-Za-z0-9_-]+)/i,
  );
  if (greenhouse && greenhouse[1].toLowerCase() !== "embed") {
    return {
      provider: "greenhouse",
      slug: greenhouse[1],
      boardUrl: `https://boards.greenhouse.io/${greenhouse[1]}`,
    };
  }

  const lever = text.match(/jobs\.lever\.co\/([A-Za-z0-9_-]+)/i);
  if (lever) {
    return {
      provider: "lever",
      slug: lever[1],
      boardUrl: `https://jobs.lever.co/${lever[1]}`,
    };
  }

  const ashby = text.match(/jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/i);
  if (ashby) {
    return {
      provider: "ashby",
      slug: ashby[1],
      boardUrl: `https://jobs.ashbyhq.com/${ashby[1]}`,
    };
  }

  const workable = text.match(/apply\.workable\.com\/([A-Za-z0-9_-]+)/i);
  if (workable && !["api", "j"].includes(workable[1].toLowerCase())) {
    return {
      provider: "workable",
      slug: workable[1],
      boardUrl: `https://apply.workable.com/${workable[1]}/`,
    };
  }
  const workableSubdomain = text.match(
    /https?:\/\/([A-Za-z0-9-]+)\.workable\.com/i,
  );
  if (
    workableSubdomain &&
    !["apply", "www", "help", "resources"].includes(
      workableSubdomain[1].toLowerCase(),
    )
  ) {
    return {
      provider: "workable",
      slug: workableSubdomain[1],
      boardUrl: `https://apply.workable.com/${workableSubdomain[1]}/`,
    };
  }

  return null;
}

/**
 * Fetch structured listings from the board's public JSON API. All four URL
 * patterns verified against live boards on 2026-08-01 (Greenhouse: stripe,
 * Lever: palantir, Ashby: openai, Workable: blueground). Returns null on
 * any failure so the caller falls through to the next tier.
 */
async function fetchAtsJobs(board: AtsBoard): Promise<Job[] | null> {
  try {
    switch (board.provider) {
      case "greenhouse": {
        const data = await fetchJson<{
          jobs?: Array<{
            title?: string;
            absolute_url?: string;
            location?: { name?: string };
            departments?: Array<{ name?: string }>;
          }>;
        }>(
          `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`,
        );
        return (data.jobs ?? [])
          .filter((j) => j.title)
          .map((j) =>
            job(
              j.title!,
              j.departments?.[0]?.name,
              j.location?.name,
              j.absolute_url,
            ),
          );
      }
      case "lever": {
        const data = await fetchJson<
          Array<{
            text?: string;
            categories?: { team?: string; location?: string };
            hostedUrl?: string;
          }>
        >(`https://api.lever.co/v0/postings/${board.slug}?mode=json`);
        if (!Array.isArray(data)) return null;
        return data
          .filter((j) => j.text)
          .map((j) =>
            job(
              j.text!,
              j.categories?.team,
              j.categories?.location,
              j.hostedUrl,
            ),
          );
      }
      case "ashby": {
        const data = await fetchJson<{
          jobs?: Array<{
            title?: string;
            department?: string;
            location?: string;
            jobUrl?: string;
            isListed?: boolean;
          }>;
        }>(`https://api.ashbyhq.com/posting-api/job-board/${board.slug}`);
        return (data.jobs ?? [])
          .filter((j) => j.title && j.isListed !== false)
          .map((j) => job(j.title!, j.department, j.location, j.jobUrl));
      }
      case "workable": {
        const data = await fetchJson<{
          jobs?: Array<{
            title?: string;
            department?: string;
            city?: string;
            country?: string;
            url?: string;
          }>;
        }>(`https://apply.workable.com/api/v1/widget/accounts/${board.slug}`);
        return (data.jobs ?? [])
          .filter((j) => j.title)
          .map((j) =>
            job(
              j.title!,
              j.department,
              [j.city, j.country].filter(Boolean).join(", ") || undefined,
              j.url,
            ),
          );
      }
    }
  } catch (err) {
    console.error(
      `[hiring-scraper] ${board.provider} API failed for slug "${board.slug}":`,
      err,
    );
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url, {}, ATS_API_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function job(
  title: string,
  department?: string,
  location?: string,
  url?: string,
): Job {
  const j: Job = { title };
  if (department) j.department = department;
  if (location) j.location = location;
  if (url) j.url = url;
  return j;
}

// ---------------------------------------------------------------------------
// Tier 3: one Haiku pass over fetched careers-page text
// ---------------------------------------------------------------------------

/**
 * Pull structured job listings out of careers-page text with one cheap LLM
 * call. Returns null on failure so the caller falls through to the browser
 * tier instead of silently storing an empty scrape.
 */
async function extractJobsFromText(
  careersUrl: string,
  content: string,
  maxJobs: number,
): Promise<Job[] | null> {
  try {
    const { object, usage } = await generateObject({
      abortSignal: llmTimeout(),
      model: anthropic(MODELS.LIGHT),
      schema: apiSafeSchema(
        z.object({
          jobs: z.array(
            z.object({
              title: z.string().describe("Job title"),
              department: z
                .string()
                .optional()
                .describe("Department or category"),
              location: z.string().optional().describe("Job location"),
            }),
          ),
        }),
      ),
      prompt: `You extract open job listings from the text of a company careers page.

${UNTRUSTED_NOTICE}

Careers page URL: ${stringify(careersUrl)}

List every open role stated on the page, up to ${maxJobs}. Only include roles the page presents as currently open. Do not invent roles, departments, or locations that the text does not state. If the page lists no open roles, return an empty list.

Page text:
${wrapUntrusted(content.slice(0, 12_000))}`,
    });

    trackUsage({
      service: "claude",
      operation: "hiring-scraper-extract",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateClaudeCostFromUsage("haiku", usage),
      metadata: {
        model: "claude-haiku-4-5",
        careersUrl,
        jobCount: object.jobs.length,
      },
    });

    return object.jobs.map((j) => job(j.title, j.department, j.location));
  } catch (err) {
    console.error("[hiring-scraper] Haiku extraction failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 4: full Stagehand browser session (the previous implementation)
// ---------------------------------------------------------------------------

/**
 * Last-resort scrape using Stagehand (Browserbase + LLM browsing). This is
 * the previous implementation of scrapeHiringData, kept verbatim; it only
 * runs when the fetch-based tiers found nothing usable.
 */
async function scrapeHiringDataWithBrowser(
  organizationId: string,
  cleanDomain: string,
  maxJobs: number,
): Promise<HiringScrapeResult> {
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
    throw new Error(`Missing required env vars for job scraping: ${missing}`);
  }

  const { Stagehand } = await import("@browserbasehq/stagehand");

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey,
    projectId,
    model: { modelName: `anthropic/${MODELS.BROWSER}`, apiKey: anthropicKey },
    disablePino: true,
  });

  try {
    await withTimeout(
      stagehand.init(),
      STAGEHAND_INIT_TIMEOUT_MS,
      "stagehand.init (hiring-scraper)",
    );

    const page = stagehand.context.pages()[0];

    // Step 1: Navigate to the company's website
    await page.goto(`https://${cleanDomain}`, {
      waitUntil: "domcontentloaded",
      timeoutMs: 30000,
    });
    await page.waitForTimeout(2000);

    // Step 2: Find and click on careers/jobs link
    const careersLinks = await stagehand.observe(
      "Find any link to a careers page, jobs page, hiring page, or 'work with us' page. Look in navigation, footer, and page body.",
    );

    let careersUrl: string | null = null;

    if (careersLinks.length > 0) {
      await stagehand.act(
        "Click on the careers, jobs, hiring, or 'work with us' link.",
      );
      await page.waitForTimeout(3000);
      careersUrl = page.url();
    } else {
      for (const path of COMMON_CAREERS_PATHS) {
        try {
          const response = await page.goto(`https://${cleanDomain}${path}`, {
            waitUntil: "domcontentloaded",
            timeoutMs: 10000,
          });
          if (response && response.ok()) {
            careersUrl = page.url();
            await page.waitForTimeout(2000);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!careersUrl) {
      await mergeEnrichmentData("organizations", organizationId, {
        hiring: {
          careersUrl: null,
          jobs: [],
          scrapedAt: new Date().toISOString(),
        },
      });
      return { careersUrl: null, jobs: [], totalJobs: 0 };
    }

    // Step 3: Extract job listings
    const jobs = await stagehand.extract(
      `Extract up to ${maxJobs} job listings from this careers/jobs page. For each job, get the title, department or category, location, and the direct URL to the job posting if available.`,
      z.array(
        z.object({
          title: z.string().describe("Job title"),
          department: z.string().optional().describe("Department or category"),
          location: z.string().optional().describe("Job location"),
          url: z.string().optional().describe("Direct link to the job posting"),
        }),
      ),
    );

    const trimmed = jobs.slice(0, maxJobs);

    // Step 4: Save hiring data to the organization
    await mergeEnrichmentData("organizations", organizationId, {
      hiring: {
        careersUrl,
        jobs: trimmed,
        scrapedAt: new Date().toISOString(),
      },
    });

    return { careersUrl, jobs: trimmed, totalJobs: jobs.length };
  } finally {
    try {
      await stagehand.close();
    } catch {
      // ignore close errors
    }
  }
}
