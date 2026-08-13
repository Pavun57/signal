import { test, expect } from "@playwright/test";
import {
  supabase,
  createTestUser,
  authCookiesFor,
  authedFetch,
  cleanupTestUsers,
  TEST_PREFIX,
  TEST_PASSWORD,
} from "./helpers";

// UI-level tests for the auth flow on Supabase email/password. We own the
// form (src/components/auth-form.tsx), the middleware redirects (proxy.ts),
// and the JWT-backed RLS contract — those are what this file guards.

test.afterAll(async () => {
  await cleanupTestUsers();
});

test.describe("middleware redirects", () => {
  test("unauthenticated / redirects to /login", async ({ page }) => {
    await page.goto("http://localhost:3000/");
    await page.waitForURL(/\/login(\?.*)?$/, { timeout: 10_000 });
    expect(page.url()).toContain("/login");
  });

  test("signed-in user visiting /login is redirected to /", async ({
    browser,
  }) => {
    const user = await createTestUser();
    const ctx = await browser.newContext();
    await ctx.addCookies(authCookiesFor(user));
    const page = await ctx.newPage();
    await page.goto("http://localhost:3000/login");
    await page.waitForURL("http://localhost:3000/", { timeout: 10_000 });
    expect(page.url()).toBe("http://localhost:3000/");
    await ctx.close();
  });

  test("public webhook routes do NOT require auth", async ({ request }) => {
    // The job routes must be publicly reachable (Vercel Cron / pg_cron can't
    // carry session cookies) but refuse work without the CRON_SECRET bearer.
    // Without that bearer the handler returns 401, NOT a 307 redirect to
    // /login.
    const res = await request.post("http://localhost:3000/api/jobs/tick", {
      data: {},
    });
    expect(res.status()).not.toBe(307);
    expect(res.status()).toBe(401);
  });
});

test.describe("session + persistence", () => {
  test("session cookie persists across reload", async ({ browser }) => {
    const user = await createTestUser();
    const ctx = await browser.newContext();
    await ctx.addCookies(authCookiesFor(user));
    const page = await ctx.newPage();

    await page.goto("http://localhost:3000/");
    await page.waitForLoadState("load");
    expect(page.url()).toBe("http://localhost:3000/");

    await page.reload();
    await page.waitForLoadState("load");
    expect(page.url()).toBe("http://localhost:3000/");

    await ctx.close();
  });

  test("clearing the session cookie redirects back to /login", async ({
    browser,
  }) => {
    const user = await createTestUser();
    const ctx = await browser.newContext();
    await ctx.addCookies(authCookiesFor(user));
    const page = await ctx.newPage();

    await page.goto("http://localhost:3000/");
    expect(page.url()).toBe("http://localhost:3000/");

    await ctx.clearCookies();
    await page.goto("http://localhost:3000/");
    await page.waitForURL(/\/login(\?.*)?$/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/login(\?.*)?$/);

    await ctx.close();
  });
});

test.describe("RLS via Supabase session JWT (the core contract)", () => {
  test("user can read their own empty campaigns list", async () => {
    const user = await createTestUser();
    const res = await authedFetch("/api/dashboard", user);
    // /api/dashboard is one of the user-authenticated routes. Expect 200 OR
    // 404/empty payload — anything except a 307/401, which would mean the
    // session JWT didn't propagate through middleware → server client → RLS.
    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(401);
    expect([200, 204, 404]).toContain(res.status);
  });

  test("user B cannot see user A's campaign (RLS isolation)", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();

    // Seed via service role so we don't depend on userA's API access.
    const { data: campaign, error } = await supabase
      .from("campaigns")
      .insert({
        name: `${TEST_PREFIX} isolation-A`,
        status: "discovery",
        icp: {},
        offering: {},
        positioning: {},
        search_criteria: {},
        user_id: userA.id,
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    // Direct PostgREST round-trip with userB's session JWT. RLS should
    // filter out userA's row.
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/campaigns?id=eq.${campaign!.id}&select=id`,
      {
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!,
          Authorization: `Bearer ${userB.accessToken}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toEqual([]);
  });

  test("user A can see their own campaign through RLS", async () => {
    const userA = await createTestUser();
    const { data: campaign } = await supabase
      .from("campaigns")
      .insert({
        name: `${TEST_PREFIX} self-A`,
        status: "discovery",
        icp: {},
        offering: {},
        positioning: {},
        search_criteria: {},
        user_id: userA.id,
      })
      .select("id")
      .single();

    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/campaigns?id=eq.${campaign!.id}&select=id`,
      {
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!,
          Authorization: `Bearer ${userA.accessToken}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(campaign!.id);
  });
});

test.describe("email/password form UI", () => {
  // Requires "Confirm email" to be OFF on the project (the self-host
  // default): signUp then returns a live session and the form routes to /.
  test("signup form creates an account and lands on /", async ({ page }) => {
    const email = `${TEST_PREFIX}ui-signup-${Date.now()}@example.com`;
    await page.goto("http://localhost:3000/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("http://localhost:3000/", { timeout: 15_000 });
    expect(page.url()).toBe("http://localhost:3000/");
  });

  test("login form rejects a wrong password with an error message", async ({
    page,
  }) => {
    const user = await createTestUser();
    await page.goto("http://localhost:3000/login");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("p.text-destructive")).toBeVisible({
      timeout: 10_000,
    });
    expect(page.url()).toContain("/login");
  });

  test("login form signs in an existing user", async ({ page }) => {
    const user = await createTestUser();
    await page.goto("http://localhost:3000/login");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("http://localhost:3000/", { timeout: 15_000 });
    expect(page.url()).toBe("http://localhost:3000/");
  });
});
