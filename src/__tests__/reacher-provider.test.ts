import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reacher (self-hosted check-if-email-exists) adapter. The load-bearing
 * behaviours: the vendor vocabulary maps onto our normalised verdicts
 * (risky stays risky — a catch-all domain must not launder a guess into a
 * verified address), and every transport failure resolves to `unknown`,
 * never `undeliverable`, so a dead backend can't delete good addresses.
 */

vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
}));

import { ReacherProvider } from "@/lib/services/providers/reacher-provider";
import { getEmailProvider } from "@/lib/services/email-provider";
import { trackUsage } from "@/lib/services/cost-tracker";

const fetchMock = vi.fn();

function reacherResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function checkBody(overrides: Record<string, unknown> = {}) {
  return {
    is_reachable: "safe",
    syntax: { is_valid_syntax: true },
    smtp: { is_catch_all: false, is_deliverable: true },
    mx: { accepts_mail: true },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("REACHER_API_URL", "http://reacher.test:8080");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(trackUsage).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReacherProvider.verifyEmail", () => {
  it("maps each is_reachable verdict onto the normalised vocabulary", async () => {
    const provider = new ReacherProvider();
    const cases: Array<[string, string]> = [
      ["safe", "deliverable"],
      ["risky", "risky"],
      ["invalid", "undeliverable"],
      ["unknown", "unknown"],
    ];
    for (const [reacherStatus, expected] of cases) {
      fetchMock.mockResolvedValueOnce(
        reacherResponse(checkBody({ is_reachable: reacherStatus })),
      );
      const result = await provider.verifyEmail("jane@acme.com");
      expect(result.status).toBe(expected);
      expect(result.raw).toBe(reacherStatus);
    }
  });

  it("posts to_email to /v0/check_email on the configured base URL", async () => {
    fetchMock.mockResolvedValueOnce(reacherResponse(checkBody()));
    await new ReacherProvider().verifyEmail("jane@acme.com");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://reacher.test:8080/v0/check_email");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ to_email: "jane@acme.com" });
  });

  it("surfaces smtp.is_catch_all as catchAll", async () => {
    fetchMock.mockResolvedValueOnce(
      reacherResponse(
        checkBody({
          is_reachable: "risky",
          smtp: { is_catch_all: true, is_deliverable: true },
        }),
      ),
    );
    const result = await new ReacherProvider().verifyEmail("jane@acme.com");
    expect(result).toMatchObject({ status: "risky", catchAll: true });
  });

  it("forces undeliverable when the syntax check fails, whatever SMTP said", async () => {
    fetchMock.mockResolvedValueOnce(
      reacherResponse(
        checkBody({
          is_reachable: "safe",
          syntax: { is_valid_syntax: false },
        }),
      ),
    );
    const result = await new ReacherProvider().verifyEmail("not-an-email");
    expect(result.status).toBe("undeliverable");
  });

  it("resolves to unknown (never throws) on HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(reacherResponse({}, 500));
    const result = await new ReacherProvider().verifyEmail("jane@acme.com");
    expect(result.status).toBe("unknown");
    expect(trackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "email_provider",
        operation: "reacher-verify-failed",
        estimated_cost_usd: 0,
      }),
    );
  });

  it("resolves to unknown (never throws) when the backend is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await new ReacherProvider().verifyEmail("jane@acme.com");
    expect(result).toEqual({ status: "unknown", catchAll: false, raw: "error" });
  });

  it("tracks every successful check at zero cost (self-hosted)", async () => {
    fetchMock.mockResolvedValueOnce(reacherResponse(checkBody()));
    await new ReacherProvider().verifyEmail("jane@acme.com");
    expect(trackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "email_provider",
        operation: "reacher-verify",
        estimated_cost_usd: 0,
        metadata: expect.objectContaining({ status: "safe" }),
      }),
    );
  });

  it("falls back to the localhost default when REACHER_API_URL is unset", async () => {
    vi.stubEnv("REACHER_API_URL", "");
    fetchMock.mockResolvedValueOnce(reacherResponse(checkBody()));
    await new ReacherProvider().verifyEmail("jane@acme.com");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:8080/v0/check_email",
    );
  });
});

describe("ReacherProvider.findEmail", () => {
  it("cannot find: returns null without touching the network", async () => {
    const provider = new ReacherProvider();
    expect(provider.canFind).toBe(false);
    const result = await provider.findEmail({
      firstName: "Jane",
      lastName: "Doe",
      domain: "acme.com",
    });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getEmailProvider registry", () => {
  it("resolves EMAIL_PROVIDER=reacher to the Reacher adapter", () => {
    vi.stubEnv("EMAIL_PROVIDER", "reacher");
    const provider = getEmailProvider();
    expect(provider?.id).toBe("reacher");
    expect(provider?.canVerify).toBe(true);
    expect(provider?.canFind).toBe(false);
  });

  it("warns and returns null for an unknown provider name", () => {
    vi.stubEnv("EMAIL_PROVIDER", "bogus");
    expect(getEmailProvider()).toBeNull();
  });
});
