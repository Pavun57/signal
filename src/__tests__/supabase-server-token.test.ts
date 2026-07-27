import { beforeEach, describe, expect, it, vi } from "vitest";

type FetchImpl = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  // One entry per createServerClient call, in order.
  fetches: [] as FetchImpl[],
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: h.auth }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { global: { fetch: FetchImpl } },
  ) => {
    h.fetches.push(options.global.fetch);
    return {};
  },
}));

/** A JWT whose payload carries a readable `exp` and an identifying marker. */
function jwt(marker: string, expiresInMs: number) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: "user_1",
      role: "authenticated",
      marker,
      exp: Math.floor((Date.now() + expiresInMs) / 1000),
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

/**
 * Stands in for Clerk's server-side getToken: bare calls return the token that
 * arrived with the request, calls passing expiresInSeconds mint a new one.
 */
function stubGetToken(
  incoming: string | null,
  minted = jwt("minted", 600_000),
) {
  return vi.fn(async (options?: { expiresInSeconds?: number }) =>
    options?.expiresInSeconds === undefined ? incoming : minted,
  );
}

function mintCalls(getToken: ReturnType<typeof stubGetToken>) {
  return getToken.mock.calls.filter(
    ([options]) => options?.expiresInSeconds !== undefined,
  );
}

function sentToken(call: readonly unknown[]) {
  const init = call[1] as RequestInit | undefined;
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  const payload = auth.replace("Bearer ", "").split(".")[1] ?? "";
  return (
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      marker: string;
    }
  ).marker;
}

describe("createClient token freshness", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Fresh module = fresh token cache.
    vi.resetModules();
    h.auth.mockReset();
    h.fetches.length = 0;
    process.env.CLERK_FRONTEND_API_DOMAIN = "test.clerk.accounts.dev";
    fetchSpy = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  // Exact body observed from PostgREST (supabase local) for an expired token.
  const expiredJwtResponse = () =>
    new Response(
      JSON.stringify({
        code: "PGRST303",
        details: null,
        hint: null,
        message: "JWT expired",
      }),
      { status: 401 },
    );

  it("reuses the request's own token while it still has life left", async () => {
    const getToken = stubGetToken(jwt("incoming", 55_000));
    h.auth.mockResolvedValue({ getToken, sessionId: "sess_1" });

    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    await h.fetches[0]("http://db/rest/v1/companies", {});

    expect(sentToken(fetchSpy.mock.calls[0])).toBe("incoming");
    expect(mintCalls(getToken)).toHaveLength(0);
  });

  it("mints a longer-lived token once the request's token is spent", async () => {
    const getToken = stubGetToken(jwt("incoming", -1_000));
    h.auth.mockResolvedValue({ getToken, sessionId: "sess_1" });

    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    await h.fetches[0]("http://db/rest/v1/companies", {});

    expect(mintCalls(getToken)).toEqual([[{ expiresInSeconds: 600 }]]);
    expect(sentToken(fetchSpy.mock.calls[0])).toBe("minted");
  });

  it("shares one mint across every client in the same session", async () => {
    const getToken = stubGetToken(jwt("incoming", -1_000));
    h.auth.mockResolvedValue({ getToken, sessionId: "sess_1" });

    const { createClient } = await import("@/lib/supabase/server");
    await Promise.all([createClient(), createClient()]);
    await Promise.all([
      h.fetches[0]("http://db/rest/v1/companies", {}),
      h.fetches[1]("http://db/rest/v1/people", {}),
    ]);

    expect(mintCalls(getToken)).toHaveLength(1);
    expect(sentToken(fetchSpy.mock.calls[0])).toBe("minted");
    expect(sentToken(fetchSpy.mock.calls[1])).toBe("minted");
  });

  it("re-mints and replays once when the token is rejected anyway", async () => {
    const getToken = stubGetToken(jwt("incoming", 55_000));
    h.auth.mockResolvedValue({ getToken, sessionId: "sess_1" });
    fetchSpy
      .mockImplementationOnce(async () => expiredJwtResponse())
      .mockImplementationOnce(async () => new Response("[]", { status: 200 }));

    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    const res = await h.fetches[0]("http://db/rest/v1/companies", {
      method: "PATCH",
      body: JSON.stringify({ name: "Acme" }),
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sentToken(fetchSpy.mock.calls[0])).toBe("incoming");
    expect(sentToken(fetchSpy.mock.calls[1])).toBe("minted");
    expect(mintCalls(getToken)).toHaveLength(1);
  });

  it("does not replay a 401 that is not about an expired token", async () => {
    const getToken = stubGetToken(jwt("incoming", 55_000));
    h.auth.mockResolvedValue({ getToken, sessionId: "sess_1" });
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: "permission denied" }), {
          status: 401,
        }),
    );

    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    const res = await h.fetches[0]("http://db/rest/v1/companies", {});

    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves the caller's response body readable after inspecting a 401", async () => {
    const getToken = stubGetToken(jwt("incoming", 55_000));
    h.auth.mockResolvedValue({ getToken, sessionId: "sess_1" });
    fetchSpy.mockImplementation(async () => expiredJwtResponse());

    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    const res = await h.fetches[0]("http://db/rest/v1/companies", {});

    // Both attempts failed, so the caller gets the 401 — and must still be
    // able to read it, since supabase-js parses the error body.
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: "PGRST303" });
  });

  it("skips the replay when the body cannot be sent twice", async () => {
    const getToken = stubGetToken(jwt("incoming", 55_000));
    h.auth.mockResolvedValue({ getToken, sessionId: "sess_1" });
    fetchSpy.mockImplementation(async () => expiredJwtResponse());

    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    const res = await h.fetches[0]("http://db/rest/v1/companies", {
      method: "POST",
      body: new ReadableStream(),
      // @ts-expect-error duplex is required for stream bodies at runtime
      duplex: "half",
    });

    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails fast instead of hanging when the mint call stalls", async () => {
    vi.useFakeTimers();
    try {
      const incoming = jwt("incoming", -1_000);
      // Mint never settles — simulates a stalled connection to api.clerk.com.
      const getToken = vi.fn((options?: { expiresInSeconds?: number }) =>
        options?.expiresInSeconds === undefined
          ? Promise.resolve(incoming)
          : new Promise<string>(() => {}),
      );
      h.auth.mockResolvedValue({ getToken, sessionId: "sess_1" });

      const { createClient } = await import("@/lib/supabase/server");
      await createClient();
      const pending = h.fetches[0]("http://db/rest/v1/companies", {});
      pending.catch(() => {}); // avoid unhandled rejection between timers
      await vi.advanceTimersByTimeAsync(16_000);

      await expect(pending).rejects.toThrow(/timed out/);
      // The wrapper never reached the network — it failed on the mint.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the plain token when there is no session to mint against", async () => {
    const getToken = stubGetToken(jwt("incoming", -1_000));
    h.auth.mockResolvedValue({ getToken, sessionId: null });

    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    await h.fetches[0]("http://db/rest/v1/companies", {});

    expect(mintCalls(getToken)).toHaveLength(0);
    expect(sentToken(fetchSpy.mock.calls[0])).toBe("incoming");
  });
});
