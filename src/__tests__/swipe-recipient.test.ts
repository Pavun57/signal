import { describe, expect, it } from "vitest";

import {
  candidateFromRow,
  pickRecipient,
  recipientLabel,
  type RealRecipient,
} from "@/lib/email-skills/swipe-recipient";

function person(
  name: string,
  opts: Partial<RealRecipient> = {},
): RealRecipient {
  return {
    personId: name,
    name,
    title: "Head of Growth",
    company: "Kindra",
    headline: null,
    signals: [],
    enriched: false,
    ...opts,
  };
}

describe("recipientLabel", () => {
  it("matches the persona label shape", () => {
    expect(recipientLabel(person("Priya Raman"))).toBe(
      "Priya Raman · Head of Growth, Kindra",
    );
  });

  it("omits missing title and company", () => {
    expect(
      recipientLabel(person("Priya Raman", { title: null, company: null })),
    ).toBe("Priya Raman");
  });
});

describe("pickRecipient", () => {
  it("prefers enriched contacts", () => {
    const picked = pickRecipient(
      [person("A"), person("B", { enriched: true })],
      [],
    );
    expect(picked?.name).toBe("B");
  });

  it("skips contacts already judged, by label", () => {
    const a = person("A", { enriched: true });
    const b = person("B", { enriched: true });
    const picked = pickRecipient([a, b], [recipientLabel(a)]);
    expect(picked?.name).toBe("B");
  });

  it("wraps around when every contact has been drafted to", () => {
    const a = person("A", { enriched: true });
    const picked = pickRecipient([a], [recipientLabel(a)]);
    expect(picked?.name).toBe("A");
  });

  it("returns null for an empty candidate list", () => {
    expect(pickRecipient([], [])).toBeNull();
  });
});

describe("candidateFromRow", () => {
  it("maps an enriched row with signals from news and articles", () => {
    const row = {
      person: {
        id: "p1",
        name: "Priya Raman",
        title: "Head of Growth",
        enrichment_status: "enriched",
        enrichment_data: {
          linkedin: { profileInfo: { headline: "Growth at Kindra" } },
          news: [
            { title: "Kindra raises Series B", publishedDate: "2026-07-01" },
          ],
          articles: [{ title: "PLG teardown", publishedDate: null }],
        },
        organization: { name: "Kindra" },
      },
    };
    const c = candidateFromRow(row);
    expect(c).toMatchObject({
      personId: "p1",
      name: "Priya Raman",
      company: "Kindra",
      enriched: true,
      headline: "Growth at Kindra",
    });
    expect(c!.signals).toEqual([
      "Kindra raises Series B (2026-07-01)",
      "PLG teardown",
    ]);
  });

  it("returns null for a row with no person or no name", () => {
    expect(candidateFromRow({ person: null })).toBeNull();
    expect(candidateFromRow({ person: { id: "x", name: "" } })).toBeNull();
  });

  it("caps signals at 5 and signal length at 200 chars", () => {
    const news = Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`.padEnd(300, "x"),
      publishedDate: null,
    }));
    const c = candidateFromRow({
      person: {
        id: "p1",
        name: "A",
        title: null,
        enrichment_status: "pending",
        enrichment_data: { news },
        organization: null,
      },
    });
    expect(c!.signals.length).toBe(5);
    expect(c!.signals[0]!.length).toBeLessThanOrEqual(200);
  });
});
