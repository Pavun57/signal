import { describe, expect, it, vi } from "vitest";

import {
  RECIPIENT_SCAN,
  resolveRecipient,
  type ContactRow,
  type ScopedClient,
} from "@/lib/email-skills/swipe-recipient";

/**
 * A stand-in for the RLS-scoped PostgREST builder. It records the filters it
 * was given, which is how the security property is asserted: every read has to
 * be constrained by `campaign_id`, because that is the only column RLS scopes
 * to the signed-in user. `people` itself is world-readable to any authenticated
 * user.
 */
function fakeClient(opts: { pinned?: ContactRow | null; list?: ContactRow[] }) {
  const calls: {
    table: string;
    filters: Record<string, string>;
    orders: string[];
    limit?: number;
    single?: boolean;
  }[] = [];

  const from = vi.fn((table: string) => {
    const call = {
      table,
      filters: {} as Record<string, string>,
      orders: [] as string[],
      limit: undefined as number | undefined,
      single: false,
    };
    calls.push(call);

    const builder = {
      select: () => builder,
      eq: (column: string, value: string) => {
        call.filters[column] = value;
        return builder;
      },
      order: (column: string) => {
        call.orders.push(column);
        return builder;
      },
      limit: (n: number) => {
        call.limit = n;
        return Promise.resolve({ data: opts.list ?? [] });
      },
      maybeSingle: () => {
        call.single = true;
        return Promise.resolve({ data: opts.pinned ?? null });
      },
    };
    return builder;
  });

  return { client: { from } as unknown as ScopedClient, calls };
}

function contact(over: Partial<ContactRow["person"]> & { id: string }) {
  return {
    person_id: over.id,
    person: {
      name: over.name ?? "Dana Whitfield",
      title: over.title ?? "VP Engineering",
      enrichment_data: over.enrichment_data ?? null,
      organization: over.organization ?? { name: "Fernpath" },
    },
  } as ContactRow;
}

describe("resolveRecipient", () => {
  it("prefers the highest-scored contact that has enrichment", async () => {
    // Ordered by priority_score descending, as the query returns them. The top
    // two have no enrichment, so a naive "take the first" picks a contact the
    // model knows nothing about and then invents facts about.
    const { client } = fakeClient({
      list: [
        contact({ id: "p1", name: "Top Scorer" }),
        contact({ id: "p2", name: "Second" }),
        contact({
          id: "p3",
          name: "Enriched One",
          enrichment_data: { headline: "shipped usage metering" },
        }),
      ],
    });

    const got = await resolveRecipient(client, "c1", null);

    expect(got?.personId).toBe("p3");
    expect(got?.recipient.name).toBe("Enriched One");
    expect(got?.recipient.enrichmentData).toEqual({
      headline: "shipped usage metering",
    });
  });

  it("falls back to the top-scored contact when nobody is enriched", async () => {
    // A real name at a real company still beats a hallucinated prospect, and
    // the prompt's no-fabrication rule covers what isn't known about them.
    const { client } = fakeClient({
      list: [contact({ id: "p1", name: "Top Scorer" }), contact({ id: "p2" })],
    });
    const got = await resolveRecipient(client, "c1", null);
    expect(got?.personId).toBe("p1");
    expect(got?.recipient.enrichmentData).toBeNull();
  });

  it("scopes every read by campaign_id, never by person id alone", async () => {
    // `people` has an RLS policy of `using (true)`, so a lookup that filtered
    // on person_id alone would hand one user another user's prospect and their
    // enrichment. campaign_people is the only user-scoped path to a contact.
    const { client, calls } = fakeClient({
      pinned: contact({ id: "p9", name: "Pinned" }),
    });

    await resolveRecipient(client, "c1", "p9");

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("campaign_people");
    expect(calls[0].filters).toEqual({ campaign_id: "c1", person_id: "p9" });
  });

  it("returns the pinned contact rather than re-picking, so the run holds still", async () => {
    // The whole reason the client sends an id back. If this re-picked, a later
    // batch could swap the prospect and a keep or pass would stop being about
    // the voice.
    const { client } = fakeClient({
      pinned: contact({ id: "p9", name: "Pinned" }),
      list: [
        contact({ id: "p1", name: "Higher Scorer", enrichment_data: { a: 1 } }),
      ],
    });
    const got = await resolveRecipient(client, "c1", "p9");
    expect(got?.personId).toBe("p9");
    expect(got?.recipient.name).toBe("Pinned");
  });

  it("re-picks when the pinned contact left the campaign mid-run", async () => {
    const { client, calls } = fakeClient({
      pinned: null,
      list: [contact({ id: "p1", name: "Still Here" })],
    });
    const got = await resolveRecipient(client, "c1", "gone");
    expect(got?.personId).toBe("p1");
    // The pinned lookup, then the fallback scan.
    expect(calls).toHaveLength(2);
  });

  it("bounds the scan", async () => {
    const { client, calls } = fakeClient({ list: [] });
    await resolveRecipient(client, "c1", null);
    expect(calls[0].limit).toBe(RECIPIENT_SCAN);
    expect(calls[0].orders).toEqual(["priority_score", "created_at"]);
  });

  // ── Degrading, none of which may throw ──────────────────────────────────
  it("returns null without a campaign, and does not query at all", async () => {
    // No campaign means no user-scoped route to any contact. Querying anyway
    // would be the bug this guards.
    const { client, calls } = fakeClient({ list: [contact({ id: "p1" })] });
    expect(await resolveRecipient(client, null, null)).toBeNull();
    expect(await resolveRecipient(client, undefined, "p1")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when the campaign has no contacts", async () => {
    const { client } = fakeClient({ list: [] });
    expect(await resolveRecipient(client, "c1", null)).toBeNull();
  });

  it("survives a link row whose person went missing", async () => {
    const { client } = fakeClient({
      list: [{ person_id: "p1", person: null }],
    });
    expect(await resolveRecipient(client, "c1", null)).toBeNull();
  });
});
