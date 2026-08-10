import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyTreasurySignature, encryptToken, decryptToken, redact } from "../src/security.js";

test("verifies HMAC over exact raw bytes", () => {
  const raw = Buffer.from('{"event":"transaction", "deliveryId":1}');
  const signature = `sha256=${crypto.createHmac("sha256", "secret").update(raw).digest("hex")}`;
  assert.equal(verifyTreasurySignature(raw, signature, "secret"), true);
  assert.equal(verifyTreasurySignature(Buffer.from(raw.toString().replace(" ", "")), signature, "secret"), false);
  assert.equal(verifyTreasurySignature(raw, "sha256=bad", "secret"), false);
});

test("AES-256-GCM encrypts and authenticates tokens", () => {
  const keys = new Map([["v1", crypto.randomBytes(32)]]);
  const encrypted = encryptToken("sensitive-token", keys, "v1");
  assert.equal(decryptToken(encrypted, keys), "sensitive-token");
  encrypted.tag = Buffer.from(encrypted.tag); encrypted.tag[0] ^= 1;
  assert.throws(() => decryptToken(encrypted, keys));
});

test("redacts bearer and JWT values", () => {
  assert.doesNotMatch(redact("Authorization: Bearer abc.def.ghi"), /abc/);
});
