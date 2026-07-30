import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function getKey(): Buffer {
  const raw = process.env.EMAIL_CREDENTIALS_KEY;
  if (!raw) {
    throw new Error(
      "EMAIL_CREDENTIALS_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env.local.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("EMAIL_CREDENTIALS_KEY must be 32 bytes, base64-encoded.");
  }
  return key;
}

/** AES-256-GCM. Format: base64(iv).base64(ciphertext).base64(authTag) */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    enc.toString("base64"),
    cipher.getAuthTag().toString("base64"),
  ].join(".");
}

export function decryptSecret(encoded: string): string {
  const [ivB64, dataB64, tagB64] = encoded.split(".");
  if (!ivB64 || !dataB64 || !tagB64) throw new Error("Malformed secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
