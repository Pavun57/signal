import { test, expect } from "@playwright/test";
import {
  supabase,
  TEST_PREFIX,
  createTestCampaign,
  linkOrgToCampaign,
  linkPersonToCampaign,
  createTestOrganization,
  createTestPerson,
  cleanupTestData,
  cleanupTestUsers,
  createTestUser,
  authedFetch,
  setDefaultTestOwner,
  type TestUser,
} from "./helpers";

/**
 * End-to-end cover for email verification and the data-quality send gate.
 *
 * The unit suites cannot reach this: `findEmailForPerson` imports the
 * server-only Supabase client, so it only runs inside Next. Every defect this
 * feature shipped was of the "never actually executed" kind — a route that
 * throws on its documented path, a gate that deadlocks, a verdict that
 * duplicates rows — so the thing worth having is a test that runs the real
 * route against the real database.
 *
 * Verification calls are billable and the free Hunter plan is small, so this
 * spends at most a couple of credits and skips cleanly when no provider is
 * configured.
 */

let testUser: TestUser;
const PROVIDER_CONFIGURED =
  !!process.env.HUNTER_API_KEY &&
  (process.env.EMAIL_PROVIDER ?? "").toLowerCase() === "hunter";

function post(path: string, body: unknown) {
  return authedFetch(path, testUser, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test.beforeAll(async () => {
  testUser = await createTestUser();
  setDefaultTestOwner(testUser.id);
});

test.afterAll(async () => {
  await cleanupTestData();
  await cleanupTestUsers();
  setDefaultTestOwner(null);
});

test("findEmail reports a stored pattern guess as untrusted", async () => {
  // This does NOT exercise the send gate (that would need a connected Gmail
  // and a draft); the gate's refusal is covered by the unit tests in
  // email-feedback-loop.test.ts. What this proves end to end is the
  // prerequisite: a pattern guess with no verification behind it is returned
  // with an explicit untrusted verification state, not presented as fact.
  const orgId = await createTestOrganization({ domain: "example.invalid" });
  const personId = await createTestPerson(orgId, {
    name: `${TEST_PREFIX} Jane Doe`,
    work_email: "jane.doe@example.invalid",
  });
  // /api/find-email gates on the person belonging to one of the caller's
  // campaigns.
  await linkPersonToCampaign(personId, await createTestCampaign());

  await supabase
    .from("people")
    .update({
      work_email_source: "pattern_derived",
      work_email_confidence: 0.2,
      work_email_verification: "unchecked",
      affiliation_source: "search_stamp",
      affiliation_confidence: 0.2,
    })
    .eq("id", personId);

  const res = await post("/api/find-email", { personId });
  expect(res.status).toBe(200);
  const body = await res.json();

  // The address is returned but explicitly not trusted, and the response says
  // how to resolve it rather than leaving the caller to guess.
  expect(body.email).toBe("jane.doe@example.invalid");
  expect(body.verification).not.toBe("deliverable");
});

test("a real mailbox verifies and becomes sendable", async () => {
  test.skip(
    !PROVIDER_CONFIGURED,
    "needs EMAIL_PROVIDER=hunter + HUNTER_API_KEY",
  );

  const orgId = await createTestOrganization({
    name: `${TEST_PREFIX} Stripe`,
    domain: "stripe.com",
  });
  // A real name, deliberately: splitName() takes the first whitespace token as
  // the given name, so a TEST_PREFIX would be sent to the provider as the first
  // name and find nothing. People and orgs are cleaned up by `source`, not by
  // name, so this is still collected.
  const personId = await createTestPerson(orgId, {
    name: "Patrick Collison",
    title: "CEO",
  });
  await linkPersonToCampaign(personId, await createTestCampaign());

  // revalidate forces paid verification now — a plain findEmail stores a free
  // suggestion and leaves proof to the send gate.
  const res = await post("/api/find-email", { personId, revalidate: true });
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.email).toBeTruthy();
  expect(body.email).toContain("@stripe.com");
  expect(body.verification).toBe("deliverable");
  expect(body.confidence).toBeGreaterThanOrEqual(0.9);

  // A verified mailbox at the employer's own domain is also proof of
  // employment — the point where the two halves of this feature meet.
  const { data: person } = await supabase
    .from("people")
    .select(
      "work_email_verification, affiliation_source, affiliation_confidence",
    )
    .eq("id", personId)
    .single();

  expect(person?.work_email_verification).toBe("deliverable");
  expect(person?.affiliation_source).toBe("email_domain");
  expect(person?.affiliation_confidence).toBeGreaterThanOrEqual(0.9);
});

test("an address proven dead is not written", async () => {
  test.skip(
    !PROVIDER_CONFIGURED,
    "needs EMAIL_PROVIDER=hunter + HUNTER_API_KEY",
  );

  // A different real domain from the test above: organizations.domain is
  // uniquely indexed, so reusing stripe.com would fail at fixture creation.
  const orgId = await createTestOrganization({
    name: `${TEST_PREFIX} Vercel`,
    domain: "vercel.com",
  });
  // A plausible-looking person who does not exist at that domain.
  const personId = await createTestPerson(orgId, {
    name: "Zzqq Nonexistentson",
  });
  await linkPersonToCampaign(personId, await createTestCampaign());

  const res = await post("/api/find-email", { personId, revalidate: true });
  expect(res.status).toBe(200);
  const body = await res.json();

  const { data: person } = await supabase
    .from("people")
    .select("work_email, work_email_verification")
    .eq("id", personId)
    .single();

  // Either nothing was found, or whatever was found is not claimed deliverable.
  if (body.email) {
    expect(person?.work_email_verification).not.toBe("deliverable");
  } else {
    expect(person?.work_email).toBeNull();
  }
});

test("contacts cannot be attached to a company with no domain", async () => {
  // Two different companies of the same name are indistinguishable without a
  // domain, which is how one company's contact list ends up holding another's.
  const { data: org } = await supabase
    .from("organizations")
    .insert({
      name: `${TEST_PREFIX} No Domain Co`,
      domain: null,
      source: "e2e_test",
    })
    .select("id")
    .single();

  // The route gates on the org belonging to one of the caller's campaigns, so
  // link it — otherwise this asserts the ownership check, not the domain gate.
  const campaignId = await createTestCampaign();
  await linkOrgToCampaign(org!.id, campaignId);

  const res = await post(`/api/companies/${org!.id}/find-more-people`, {});
  const body = await res.json();

  // The refusal has to reach the caller, not be swallowed into "0 results".
  expect(body.error ?? "").toMatch(/no domain/i);
  expect(body.added ?? 0).toBe(0);
});
