import { describe, expect, it, vi, afterEach } from "vitest";

import {
  addressIsPublic,
  assertPublicUrl,
  BlockedUrlError,
  readBodyCapped,
  safeFetch,
  type HostResolver,
} from "@/lib/safe-fetch";

/**
 * DNS is injected rather than mocked. The guard's whole job is to refuse a
 * hostname that resolves somewhere private, so a test has to be able to state
 * the answer -- and these must not depend on the network to run.
 */
const resolvesTo =
  (...addresses: string[]): HostResolver =>
  async () =>
    addresses;

const publicDns = resolvesTo("93.184.216.34");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addressIsPublic", () => {
  const blocked = [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4 in IPv6 clothing
  ];
  for (const ip of blocked) {
    it(`refuses ${ip}`, () => expect(addressIsPublic(ip)).toBe(false));
  }

  const allowed = ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111"];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(addressIsPublic(ip)).toBe(true));
  }
});

describe("assertPublicUrl", () => {
  it("refuses a non-http scheme rather than coercing it", async () => {
    // The website route used to prepend https:// to anything unschemed, so
    // file:///etc/passwd parsed to the host "file" and was stored as a domain.
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(
      BlockedUrlError,
    );
  });

  it("refuses a literal private address", async () => {
    await expect(
      assertPublicUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/not a publicly routable address/);
  });

  it("refuses a single-label host", async () => {
    await expect(assertPublicUrl("http://localhost:3000/")).rejects.toThrow(
      /not a public hostname/,
    );
  });

  it("refuses a public name that resolves to a private address", async () => {
    await expect(
      assertPublicUrl("https://evil.example.com/", resolvesTo("127.0.0.1")),
    ).rejects.toThrow(/not publicly routable/);
  });

  it("refuses when any one of several addresses is private", async () => {
    await expect(
      assertPublicUrl(
        "https://evil.example.com/",
        resolvesTo("93.184.216.34", "10.0.0.5"),
      ),
    ).rejects.toThrow(/not publicly routable/);
  });

  it("allows an ordinary public URL", async () => {
    const url = await assertPublicUrl("https://example.com/careers", publicDns);
    expect(url.hostname).toBe("example.com");
  });
});

describe("safeFetch redirects", () => {
  function response(status: number, headers: Record<string, string> = {}) {
    return new Response(null, { status, headers });
  }

  it("revalidates each hop, so a public host cannot bounce to the metadata service", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response(302, { location: "http://169.254.169.254/latest/meta-data/" }),
      );

    await expect(
      safeFetch("https://example.com/", {}, { resolveHost: publicDns }),
    ).rejects.toThrow(/not a publicly routable address/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after the hop limit instead of following forever", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response(302, { location: "https://example.com/next" }),
    );

    await expect(
      safeFetch(
        "https://example.com/",
        {},
        { maxRedirects: 2, resolveHost: publicDns },
      ),
    ).rejects.toThrow(/Too many redirects/);
  });

  it("returns a non-redirect response as-is", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("hello", { status: 200 }),
    );

    const res = await safeFetch(
      "https://example.com/",
      {},
      { resolveHost: publicDns },
    );
    expect(res.status).toBe(200);
  });
});

describe("readBodyCapped", () => {
  it("refuses a body whose declared length is over the cap", async () => {
    const res = new Response("x", {
      headers: { "content-length": "99999999" },
    });
    await expect(readBodyCapped(res, 1000)).rejects.toThrow(/over the/);
  });

  it("stops reading once the cap is passed", async () => {
    const chunk = new TextEncoder().encode("a".repeat(1000));
    let pushed = 0;
    const body = new ReadableStream({
      pull(controller) {
        pushed++;
        if (pushed > 100) return controller.close();
        controller.enqueue(chunk);
      },
    });

    const text = await readBodyCapped(new Response(body), 5000);

    // Capped rather than drained: without the ceiling this reads 100kB.
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(pushed).toBeLessThan(20);
  });
});
