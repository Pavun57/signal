import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
  sessionsUpdate: vi.fn(),
  sessionsDebug: vi.fn(),
  connectOverCDP: vi.fn(),
  browserClose: vi.fn(),
  pageGoto: vi.fn(),
}));

vi.mock("@browserbasehq/sdk", () => ({
  default: class {
    sessions = {
      create: h.sessionsCreate,
      update: h.sessionsUpdate,
      debug: h.sessionsDebug,
    };
  },
}));
vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP: h.connectOverCDP },
}));
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  PRICING: { browserbase_fetch: 0, browserbase_session_per_hr: 0 },
}));
vi.mock("@/lib/fetch-with-timeout", () => ({
  // Force the direct-fetch and browserbase-fetch tiers to fail so extract()
  // cascades to the browser-session path under test.
  fetchWithTimeout: vi.fn(async () => {
    throw new Error("no fetch in test");
  }),
}));

import { WebExtractionService } from "@/lib/services/web-extraction-service";

function fakeBrowser(html = "<html><body>hello world</body></html>") {
  const page = {
    goto: h.pageGoto,
    waitForTimeout: vi.fn(async () => {}),
    content: vi.fn(async () => html),
  };
  return {
    contexts: () => [{ pages: () => [page] }],
    close: h.browserClose,
  };
}

describe("Browserbase session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no direct fetch in test");
      }),
    );
    process.env.BROWSERBASE_API_KEY = "bb_test";
    process.env.BROWSERBASE_PROJECT_ID = "proj_test";
    h.sessionsCreate.mockResolvedValue({
      id: "sess_1",
      connectUrl: "ws://localhost/devtools",
    });
    h.sessionsUpdate.mockResolvedValue({});
    h.connectOverCDP.mockResolvedValue(fakeBrowser());
    h.browserClose.mockResolvedValue(undefined);
    h.pageGoto.mockResolvedValue(undefined);
  });

  it("releases the session slot after a successful extraction", async () => {
    const result = await new WebExtractionService().extract(
      "https://example.com",
    );

    expect(result.source).toBe("browserbase-browser");
    expect(h.browserClose).toHaveBeenCalledTimes(1);
    // Closing the browser is not enough — the slot must be handed back.
    expect(h.sessionsUpdate).toHaveBeenCalledWith("sess_1", {
      projectId: "proj_test",
      status: "REQUEST_RELEASE",
    });
  });

  it("releases the session slot when the page navigation fails", async () => {
    h.pageGoto.mockRejectedValue(new Error("nav timeout"));

    const result = await new WebExtractionService().extract(
      "https://example.com",
    );

    expect(result.success).toBe(false);
    expect(h.sessionsUpdate).toHaveBeenCalledWith("sess_1", {
      projectId: "proj_test",
      status: "REQUEST_RELEASE",
    });
  });

  it("releases the session slot when the CDP connect fails", async () => {
    h.connectOverCDP.mockRejectedValue(new Error("cdp refused"));

    const result = await new WebExtractionService().extract(
      "https://example.com",
    );

    expect(result.success).toBe(false);
    // The session was created, so it must be released even though no
    // browser was ever connected — this is the leak that filled the plan's
    // concurrency limit and made later creates queue forever.
    expect(h.browserClose).not.toHaveBeenCalled();
    expect(h.sessionsUpdate).toHaveBeenCalledWith("sess_1", {
      projectId: "proj_test",
      status: "REQUEST_RELEASE",
    });
  });

  it("times out instead of queueing forever when session creation stalls", async () => {
    vi.useFakeTimers();
    try {
      h.sessionsCreate.mockImplementation(() => new Promise(() => {}));

      const pending = new WebExtractionService().extract("https://example.com");
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(46_000);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out/i);
      expect(h.connectOverCDP).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
