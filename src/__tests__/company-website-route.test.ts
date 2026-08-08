import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake, type FakeRow } from "./helpers/supabase-fake";

/**
 * Saving the website a company never had, including when another row already
 * holds it.
 *
 * `organizations.domain` has a unique index, so writing a domain that another
 * company already owns is a constraint violation, not an update. That case is
 * not exotic here: the agent's old documented workaround (search for the
 * website, save it) INSERTed a second company for exactly these companies, so
 * a duplicate holding the right domain is precisely what a user is likely to
 * have sitting in the database already.
 *
 * A merge moves things and only then deletes. Deleting first would take the
 * campaign links, tracked signals and people with it: `campaign_organizations`,
 * `signal_results` and `tracking_configs` all cascade on delete, and
 * `people.organization_id` nulls out, which is the silent version of losing a
 * contact list.
 */

const ORG = "org-domainless";
const TWIN = "org-with-domain";
const CAMPAIGN = "campaign-1";
const OTHER_CAMPAIGN = "campaign-2";

const resolveOrganizationDomain = vi.fn();
vi.mock("@/lib/services/domain-resolver", () => ({
  resolveOrganizationDomain: (...args: unknown[]) =>
    (resolveOrganizationDomain as unknown as (...a: unknown[]) => unknown)(
      ...args,
    ),
}));

interface State {
  organizations: FakeRow[];
  campaign_organizations: FakeRow[];
  campaign_people: FakeRow[];
  people: FakeRow[];
  signal_results: FakeRow[];
  tracking_configs: FakeRow[];
  /** Table whose writes should fail, so a half-finished merge is testable. */
  failWritesOn: string | null;
  /** Table the fake is mutating right now, set by onQuery just before the write. */
  mutating: string | null;
}

const state: State = {
  organizations: [],
  campaign_organizations: [],
  campaign_people: [],
  people: [],
  signal_results: [],
  tracking_configs: [],
  failWritesOn: null,
  mutating: null,
};

vi.mock("@/lib/supabase/server", () => {
  const supabase = () =>
    createSupabaseFake({
      tables: {
        campaigns: () => [
          { id: CAMPAIGN, user_id: "user-1" },
          { id: OTHER_CAMPAIGN, user_id: "user-1" },
        ],
        organizations: () => state.organizations,
        campaign_organizations: () => state.campaign_organizations,
        campaign_people: () => state.campaign_people,
        people: () => state.people,
        signal_results: () => state.signal_results,
        tracking_configs: () => state.tracking_configs,
      },
      relations: {
        campaign_organizations: { campaign: { localKey: "campaign_id" } },
      },
      // onQuery fires immediately before the write is applied, so this pair
      // targets a single table's writes rather than failing every write.
      onQuery: (q) => {
        state.mutating = q.kind === "select" ? null : q.table;
      },
      updateError: () =>
        state.failWritesOn && state.mutating === state.failWritesOn
          ? { message: `write to ${state.failWritesOn} refused` }
          : null,
    });

  return {
    createClient: vi.fn(async () => supabase()),
    getSupabaseAndUser: vi.fn(async () => ({
      supabase: supabase(),
      user: { id: "user-1", email: "u@example.com" },
    })),
  };
});

/**
 * The admin client, sharing the same fixture tables. The merge's emptiness
 * check and final delete run through it: the orgs_delete RLS policy requires
 * a campaign link the merge has just moved away, so the user-scoped delete
 * matched zero rows on every install. Deletes are recorded so a test can
 * assert which client performed them.
 */
const adminOps: Array<{ kind: string; table: string }> = [];
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () =>
    createSupabaseFake({
      tables: {
        organizations: () => state.organizations,
        campaign_organizations: () => state.campaign_organizations,
        campaign_people: () => state.campaign_people,
        people: () => state.people,
        signal_results: () => state.signal_results,
        tracking_configs: () => state.tracking_configs,
      },
      onQuery: (q) => {
        if (q.kind !== "select")
          adminOps.push({ kind: q.kind, table: q.table });
      },
    }),
}));

import { PATCH } from "@/app/api/companies/[id]/website/route";

function patch(body: Record<string, unknown>, id = ORG) {
  return PATCH(
    new Request(`http://test/api/companies/${id}/website`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  resolveOrganizationDomain.mockReset();
  state.organizations = [
    {
      id: ORG,
      name: "Cedar Lodge Nursing Home",
      domain: null,
      url: null,
      location: "Birmingham",
      industry: "Nursing Home",
    },
  ];
  state.campaign_people = [];
  state.campaign_organizations = [
    { id: "co-1", campaign_id: CAMPAIGN, organization_id: ORG },
  ];
  state.people = [];
  state.signal_results = [];
  state.tracking_configs = [];
  state.failWritesOn = null;
  state.mutating = null;
  adminOps.length = 0;
});

/** The organization row as it stands now, so writes are observable. */
const org = (id: string) => state.organizations.find((o) => o.id === id);

describe("PATCH /api/companies/[id]/website", () => {
  it("saves an address the user typed", async () => {
    const res = await patch({ url: "https://www.cedarlodge.co.uk/about-us" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.domain).toBe("cedarlodge.co.uk");
    expect(org(ORG)?.domain).toBe("cedarlodge.co.uk");
    expect(org(ORG)?.url).toBe("https://cedarlodge.co.uk");
    // A typed address is the highest-confidence source there is, so it does
    // not pay for a lookup.
    expect(resolveOrganizationDomain).not.toHaveBeenCalled();
  });

  it("resolves one when asked to", async () => {
    resolveOrganizationDomain.mockResolvedValue({
      domain: "cedarlodge.co.uk",
      url: "https://cedarlodge.co.uk",
      source: "google_places",
      evidence: "Google Places lists Cedar Lodge Nursing Home in Birmingham",
    });

    const res = await patch({ resolve: true });
    const body = await res.json();

    expect(body.domain).toBe("cedarlodge.co.uk");
    expect(body.source).toBe("google_places");
    expect(org(ORG)?.domain).toBe("cedarlodge.co.uk");
  });

  it("reports a failed resolve without writing anything", async () => {
    resolveOrganizationDomain.mockResolvedValue(null);

    const res = await patch({ resolve: true });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.error).toMatch(/could not find/i);
    expect(org(ORG)?.domain).toBeNull();
  });

  it("refuses a directory address", async () => {
    // Contacts would then be searched against the directory, and every person
    // found there filed under it.
    const res = await patch({ url: "https://www.carehome.co.uk/id/1234" });

    expect(res.status).toBe(400);
    expect(org(ORG)?.domain).toBeNull();
  });

  it("refuses to overwrite a website already on record", async () => {
    state.organizations[0].domain = "already.co.uk";

    const res = await patch({ url: "https://something-else.co.uk" });

    expect(res.status).toBe(400);
    expect(org(ORG)?.domain).toBe("already.co.uk");
  });

  describe("when another company already holds that domain", () => {
    beforeEach(() => {
      state.organizations.push({
        id: TWIN,
        name: "Cedar Lodge Nursing Home",
        domain: "cedarlodge.co.uk",
        url: "https://cedarlodge.co.uk",
        location: "Birmingham",
        industry: "Nursing Home",
      });
    });

    it("moves the campaign links, people and tracked signals, then deletes the empty row", async () => {
      state.people.push({ id: "p1", organization_id: ORG });
      // The caller has to hold the contact for it to move; people is a shared
      // pool, so campaign_people is what says whose it is.
      state.campaign_people.push({
        id: "cp-1",
        campaign_id: CAMPAIGN,
        person_id: "p1",
      });
      state.signal_results.push({ id: "sr1", organization_id: ORG });
      state.tracking_configs.push({ id: "tc1", organization_id: ORG });

      const res = await patch({ url: "https://cedarlodge.co.uk" });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.merged).toBe(true);
      expect(body.into).toBe(TWIN);

      expect(state.campaign_organizations[0].organization_id).toBe(TWIN);
      expect(state.people[0].organization_id).toBe(TWIN);
      expect(state.signal_results[0].organization_id).toBe(TWIN);
      expect(state.tracking_configs[0].organization_id).toBe(TWIN);
      expect(org(ORG)).toBeUndefined();
      expect(body.deletedOld).toBe(true);
    });

    it("leaves another tenant's contact where it is, and keeps the old row", async () => {
      // Reproduced live before this guard existed: `people` is USING (true)
      // on UPDATE, so the merge rewrote every tenant's rows at the company.
      // One user setting a website re-filed another user's contact under a
      // different employer and emptied their campaign.
      state.people.push({ id: "mine", organization_id: ORG });
      state.people.push({ id: "theirs", organization_id: ORG });
      state.campaign_people.push({
        id: "cp-1",
        campaign_id: CAMPAIGN,
        person_id: "mine",
      });
      // "theirs" is in nobody's campaign that this caller can see.

      const res = await patch({ url: "https://cedarlodge.co.uk" });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(state.people.find((p) => p.id === "mine")?.organization_id).toBe(
        TWIN,
      );
      expect(state.people.find((p) => p.id === "theirs")?.organization_id).toBe(
        ORG,
      );
      // Something still points at the old row, so it must survive.
      expect(org(ORG)).toBeDefined();
      expect(body.deletedOld).toBe(false);
    });

    it("drops a link that would duplicate one the twin already has", async () => {
      // unique(campaign_id, organization_id) on campaign_organizations. Moving
      // this link would violate it, and failing the whole merge over a
      // duplicate would leave the company stranded for good.
      state.campaign_organizations.push({
        id: "co-2",
        campaign_id: CAMPAIGN,
        organization_id: TWIN,
      });

      await patch({ url: "https://cedarlodge.co.uk" });

      const links = state.campaign_organizations.filter(
        (l) => l.campaign_id === CAMPAIGN,
      );
      expect(links).toHaveLength(1);
      expect(links[0].organization_id).toBe(TWIN);
      expect(org(ORG)).toBeUndefined();
    });

    it("keeps the old row when a move did not land", async () => {
      // Deleting the old company cascades to its campaign links, tracked
      // signals and signal results, and nulls out people.organization_id. So a
      // move that failed has to stop the delete: a contact list quietly
      // detached is worse than a duplicate company row left on screen.
      state.people.push({ id: "p-stuck", organization_id: ORG });
      state.failWritesOn = "people";

      const res = await patch({ url: "https://cedarlodge.co.uk" });
      const body = await res.json();

      expect(body.merged).toBe(true);
      expect(body.deletedOld).toBe(false);
      expect(state.people[0].organization_id).toBe(ORG);
      expect(org(ORG)).toBeDefined();
    });
  });
});

describe("the merge's final delete", () => {
  it("runs through the admin client, which is the only one that can do it", async () => {
    // The orgs_delete policy requires a campaign_organizations link from the
    // caller's campaign to the row, and the merge has just moved every such
    // link to the twin: the user-scoped DELETE matched zero rows and returned
    // no error, so every merge on every install left an orphaned domain-less
    // duplicate and reported "The old entry was kept: 0 row(s) still point at
    // it."
    state.organizations.push({
      id: TWIN,
      name: "Cedar Lodge Nursing Home",
      domain: "cedarlodge.co.uk",
      url: "https://cedarlodge.co.uk",
    });
    resolveOrganizationDomain.mockResolvedValue({
      domain: "cedarlodge.co.uk",
      url: "https://cedarlodge.co.uk",
      source: "google_places",
      evidence: "Google Places lists Cedar Lodge Nursing Home",
    });

    const res = await patch({ resolve: true });
    const body = (await res.json()) as {
      merged?: boolean;
      deletedOld?: boolean;
    };

    expect(body.merged).toBe(true);
    expect(body.deletedOld).toBe(true);
    expect(org(ORG)).toBeUndefined();
    expect(
      adminOps.filter(
        (op) => op.kind === "delete" && op.table === "organizations",
      ),
    ).toHaveLength(1);
  });
});
