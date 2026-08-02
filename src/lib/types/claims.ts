export const CLAIM_TYPES = [
  "funding_round",
  "headcount",
  "hiring_role",
  "exec_change",
  "product",
  "location",
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

export type ClaimStatus =
  | "verified"
  | "unverified"
  | "stale"
  | "contradicted"
  | "superseded";

export interface CompanyClaim {
  type: ClaimType;
  /** One factual sentence, e.g. "Raised a $30M Series B led by Madrona". */
  statement: string;
  sourceUrl: string;
  /** ISO date of the source when known; null when the source is undated. */
  publishedDate: string | null;
  /** 0-1, extractor's confidence the statement is about this company. */
  confidence: number;
  extractedAt: string;
  status: ClaimStatus;
}

export interface CareersScrape {
  careersUrl: string | null;
  jobs: Array<{ title: string; department?: string; location?: string }>;
  scrapedAt: string;
}
