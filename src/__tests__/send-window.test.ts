import { describe, it, expect } from "vitest";
import { isWithinSendWindow } from "@/lib/services/gmail-service";

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
