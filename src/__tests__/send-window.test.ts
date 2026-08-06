import { describe, it, expect } from "vitest";
import {
  isWithinSendWindow,
  localSendClock,
} from "@/lib/services/gmail-service";

// 2026-08-05T15:30:00Z == 08:30 in America/Los_Angeles, 17:30 in Europe/Berlin
const now = new Date("2026-08-05T15:30:00Z");

describe("isWithinSendWindow", () => {
  it("no window configured → always sendable", () => {
    expect(isWithinSendWindow(null, null, "America/Los_Angeles", now)).toBe(
      true,
    );
  });
  it("inside a same-day window", () => {
    expect(isWithinSendWindow(8, 17, "America/Los_Angeles", now)).toBe(true);
  });
  it("outside a same-day window", () => {
    expect(isWithinSendWindow(9, 17, "Europe/Berlin", now)).toBe(false); // 17:30, end is exclusive
  });
  it("overnight window wrapping midnight", () => {
    expect(isWithinSendWindow(16, 9, "Europe/Berlin", now)).toBe(true); // 17:30 ∈ [16, 9)
    expect(isWithinSendWindow(20, 6, "Europe/Berlin", now)).toBe(false);
  });
  it("degenerate equal start/end → no window", () => {
    expect(isWithinSendWindow(9, 9, "Europe/Berlin", now)).toBe(true);
  });
  it("invalid timezone fails open: a window is a deliverability nicety, not a safety gate", () => {
    expect(isWithinSendWindow(0, 1, "Not/AZone", now)).toBe(true);
  });
});

describe("localSendClock", () => {
  // `now` is a Wednesday.
  it("reports hour and weekday in the given zone", () => {
    expect(localSendClock("America/Los_Angeles", now)).toEqual({
      hour: 8,
      weekday: 3,
    });
    expect(localSendClock("Europe/Berlin", now)).toEqual({
      hour: 17,
      weekday: 3,
    });
  });
  it("crosses the date line correctly", () => {
    // 15:30Z Wednesday is already 01:30 Thursday in Auckland (UTC+12/+13).
    const auckland = localSendClock("Pacific/Auckland", now);
    expect(auckland?.weekday).toBe(4);
  });
  it("null timezone means UTC", () => {
    expect(localSendClock(null, now)).toEqual({ hour: 15, weekday: 3 });
  });
  it("invalid timezone returns null rather than a wrong snapshot", () => {
    expect(localSendClock("Not/AZone", now)).toBeNull();
  });
  it("agrees with isWithinSendWindow about the hour", () => {
    const clock = localSendClock("Europe/Berlin", now)!;
    // 17:30 Berlin: a window ending at 17 excludes it, one ending at 18 does not.
    expect(isWithinSendWindow(9, clock.hour, "Europe/Berlin", now)).toBe(false);
    expect(isWithinSendWindow(9, clock.hour + 1, "Europe/Berlin", now)).toBe(
      true,
    );
  });
});
