import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret } from "@/lib/crypto";

describe("secret encryption", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.EMAIL_CREDENTIALS_KEY;
    process.env.EMAIL_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
  });
  afterEach(() => {
    process.env.EMAIL_CREDENTIALS_KEY = savedKey;
  });

  it("round-trips", () => {
    const enc = encryptSecret("abcd efgh ijkl mnop");
    expect(enc).not.toContain("abcd");
    expect(decryptSecret(enc)).toBe("abcd efgh ijkl mnop");
  });

  it("produces a different ciphertext each call (random IV)", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("secret");
    const parts = enc.split(".");
    parts[2] = parts[2].slice(0, -2) + "AA";
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("throws a clear error when the key is missing", () => {
    delete process.env.EMAIL_CREDENTIALS_KEY;
    expect(() => encryptSecret("x")).toThrow(/EMAIL_CREDENTIALS_KEY/);
  });

  it("throws when the key is the wrong length", () => {
    process.env.EMAIL_CREDENTIALS_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});
