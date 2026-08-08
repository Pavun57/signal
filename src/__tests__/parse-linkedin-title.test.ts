import { describe, it, expect } from "vitest";

import { parseLinkedInTitle } from "@/lib/utils";

/**
 * Whatever this returns as `title` is stored on the contact and personalised
 * against by outreach. The site suffix is the trap: LinkedIn titles all end in
 * "| LinkedIn", and a profile with no visible headline is JUST "Name | LinkedIn",
 * so a naive split stores the string "LinkedIn" as a real person's job title.
 */
describe("parseLinkedInTitle", () => {
  it("splits a name and headline", () => {
    expect(parseLinkedInTitle("Jane Doe - VP Sales | Acme Corp")).toEqual({
      name: "Jane Doe",
      title: "VP Sales",
    });
  });

  it("does not store the site suffix as a job title", () => {
    expect(parseLinkedInTitle("Jane Doe | LinkedIn")).toEqual({
      name: "Jane Doe",
      title: null,
    });
  });

  it("strips the suffix before splitting the rest", () => {
    expect(parseLinkedInTitle("Jane Doe - Acme Corp | LinkedIn")).toEqual({
      name: "Jane Doe",
      title: "Acme Corp",
    });
  });

  it("returns Unknown for empty input", () => {
    expect(parseLinkedInTitle(undefined)).toEqual({
      name: "Unknown",
      title: null,
    });
    expect(parseLinkedInTitle("")).toEqual({ name: "Unknown", title: null });
  });
});
