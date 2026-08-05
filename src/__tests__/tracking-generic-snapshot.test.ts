import { describe, it, expect } from "vitest";
import {
  buildGenericSnapshot,
  hashSnapshot,
} from "@/lib/services/tracking-differ";

describe("buildGenericSnapshot", () => {
  it("projects exa_search output to sorted (title, url) pairs, dropping volatile fields", () => {
    const raw = {
      query: "Acme funding",
      resultCount: 2,
      results: [
        {
          title: "B",
          url: "https://b.com",
          publishedDate: "2026-08-05",
          text: "varies",
        },
        {
          title: "A",
          url: "https://a.com",
          publishedDate: "2026-08-04",
          text: "varies too",
        },
      ],
    };
    const snap = buildGenericSnapshot("exa_search", raw);
    expect(snap.data).toEqual({
      results: [
        { title: "A", url: "https://a.com" },
        { title: "B", url: "https://b.com" },
      ],
    });
  });

  it("hashes identically when only volatile exa fields change", () => {
    const base = {
      results: [
        { title: "A", url: "https://a.com", text: "x", publishedDate: "1" },
      ],
      resultCount: 1,
    };
    const later = {
      results: [
        { title: "A", url: "https://a.com", text: "y", publishedDate: "2" },
      ],
      resultCount: 1,
    };
    expect(hashSnapshot(buildGenericSnapshot("exa_search", base))).toBe(
      hashSnapshot(buildGenericSnapshot("exa_search", later)),
    );
  });

  it("hashes differently when a new result appears", () => {
    const base = { results: [{ title: "A", url: "https://a.com" }] };
    const later = {
      results: [
        { title: "A", url: "https://a.com" },
        { title: "B", url: "https://b.com" },
      ],
    };
    expect(hashSnapshot(buildGenericSnapshot("exa_search", base))).not.toBe(
      hashSnapshot(buildGenericSnapshot("exa_search", later)),
    );
  });

  it("passes through non-exa output unchanged", () => {
    const raw = { tiers: [{ name: "Pro", price: 49 }] };
    const snap = buildGenericSnapshot("browser_script", raw);
    expect(snap.data).toEqual(raw);
    expect(snap.execution_type).toBe("browser_script");
  });

  it("hashSnapshot is key-order independent (existing behavior, now on generic snapshots)", () => {
    const a = buildGenericSnapshot("tool_call", { x: 1, y: { b: 2, a: 1 } });
    const b = buildGenericSnapshot("tool_call", { y: { a: 1, b: 2 }, x: 1 });
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
  });
});
