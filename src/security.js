import crypto from "node:crypto";

export function verifyTreasurySignature(rawBody, signatureHeader, secret) {
  if (!Buffer.isBuffer(rawBody) || !secret || typeof signatureHeader !== "string") return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(match[1], "hex");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function parseEncryptionKeys(spec = process.env.TOKEN_ENCRYPTION_KEYS || "") {
  const keys = new Map();
  for (const part of spec.split(",").filter(Boolean)) {
    const separator = part.indexOf(":");
    if (separator < 1) throw new Error("TOKEN_ENCRYPTION_KEYS must use version:base64 entries");
    const version = part.slice(0, separator);
    const key = Buffer.from(part.slice(separator + 1), "base64");
    if (key.length !== 32) throw new Error(`Encryption key ${version} is not 32 bytes`);
    keys.set(version, key);
  }
  return keys;
}

export function encryptToken(token, keys, activeVersion) {
  const key = keys.get(activeVersion);
  if (!key) throw new Error("Active encryption key is unavailable");
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { version: activeVersion, nonce, tag: cipher.getAuthTag(), ciphertext };
}

export function decryptToken(record, keys) {
  const key = keys.get(record.version);
  if (!key) throw new Error("Token encryption key version is unavailable");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, record.nonce);
  decipher.setAuthTag(record.tag);
  return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
}

export function hashFingerprint(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function redact(value) {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "");
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer <redacted>")
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted-jwt>");
}
