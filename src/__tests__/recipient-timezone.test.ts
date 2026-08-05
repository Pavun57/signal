import { describe, it, expect } from "vitest";
import {
  resolveTimezoneFromLocation,
  LOCATION_TIMEZONES,
} from "@/lib/services/recipient-timezone";

describe("resolveTimezoneFromLocation", () => {
  it("resolves major cities", () => {
    expect(resolveTimezoneFromLocation("San Francisco, CA")).toBe(
      "America/Los_Angeles",
    );
    expect(resolveTimezoneFromLocation("London, United Kingdom")).toBe(
      "Europe/London",
    );
    expect(resolveTimezoneFromLocation("Berlin, Germany")).toBe(
      "Europe/Berlin",
    );
    expect(resolveTimezoneFromLocation("Bengaluru, India")).toBe(
      "Asia/Kolkata",
    );
  });

  it("prefers city over country when both match", () => {
    // "Sydney, Australia": Australia alone is multi-zone (unmappable), the
    // city pins it.
    expect(resolveTimezoneFromLocation("Sydney, Australia")).toBe(
      "Australia/Sydney",
    );
  });

  it("resolves US state abbreviations after a comma", () => {
    expect(resolveTimezoneFromLocation("Boulder, CO")).toBe("America/Denver");
    expect(resolveTimezoneFromLocation("Somewhere, TX, USA")).toBe(
      "America/Chicago",
    );
  });

  it("does not treat mid-word letter pairs as state codes", () => {
    // "co" inside a word or country name must not match Colorado.
    expect(resolveTimezoneFromLocation("Cortina, Mexico")).toBeNull();
  });

  it("returns null for multi-timezone countries without a city or state", () => {
    expect(resolveTimezoneFromLocation("United States")).toBeNull();
    expect(resolveTimezoneFromLocation("Canada")).toBeNull();
    expect(resolveTimezoneFromLocation("Australia")).toBeNull();
  });

  it("resolves single-zone countries", () => {
    expect(resolveTimezoneFromLocation("France")).toBe("Europe/Paris");
    expect(resolveTimezoneFromLocation("Japan")).toBe("Asia/Tokyo");
    expect(resolveTimezoneFromLocation("Netherlands")).toBe("Europe/Amsterdam");
  });

  it("uses the first hint that resolves, skipping null/empty/unknown", () => {
    expect(
      resolveTimezoneFromLocation(null, undefined, "Remote", "Paris, France"),
    ).toBe("Europe/Paris");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveTimezoneFromLocation("Remote", "Earth", null)).toBeNull();
    expect(resolveTimezoneFromLocation()).toBeNull();
  });

  it("every mapped timezone is a valid IANA identifier", () => {
    for (const tz of new Set(Object.values(LOCATION_TIMEZONES))) {
      expect(
        () => new Intl.DateTimeFormat("en-US", { timeZone: tz }),
        `invalid timezone in map: ${tz}`,
      ).not.toThrow();
    }
  });
});
