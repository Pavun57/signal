import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Parse a LinkedIn search result title like "Jane Doe - VP Sales | Acme Corp" */
export function parseLinkedInTitle(raw: string | undefined): {
  name: string;
  title: string | null;
} {
  if (!raw) return { name: "Unknown", title: null };
  // Strip the site suffix first. A profile with no visible headline is titled
  // just "Jane Doe | LinkedIn", and splitting that stores the string
  // "LinkedIn" as a real person's job title, which outreach then
  // personalises against.
  const cleaned = raw.replace(/\s*[-|]\s*LinkedIn\s*$/i, "");
  const parts = cleaned.split(/\s[-|]\s/);
  return {
    name: parts[0]?.trim() || "Unknown",
    title: parts[1]?.trim() || null,
  };
}
