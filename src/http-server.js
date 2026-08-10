import http from "node:http";
import crypto from "node:crypto";
import { pool, ready, withTransaction } from "./database.js";
import { verifyTreasurySignature, parseEncryptionKeys, decryptToken, encryptToken, hashFingerprint, redact } from "./security.js";
import { TreasuryClient, validatePersonalToken } from "./treasury-client.js";
import { subscriptionForTreasuryId, ingestDelivery } from "./finance-repository.js";
import { parseTreasuryJson } from "./treasury-json.js";
import { publicBaseUrl } from "./public-url.js";

const MAX_BODY = 128 * 1024;

async function rawBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body, contentType = "application/json") {
  res.writeHead(status, { "Content-Type": `${contentType}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  res.end(contentType === "application/json" ? JSON.stringify(body) : body);
}

function connectPage(message = "") {
  const safe = String(message).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Treasury</title><style>body{font:16px system-ui;max-width:560px;margin:10vh auto;padding:24px;background:#101217;color:#eee}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:12px;border-radius:8px}button{font-weight:700}small{color:#aaa}.msg{padding:10px;background:#252936}</style><h1>Connect Treasury securely</h1>${safe ? `<p class="msg">${safe}</p>` : ""}<p>Paste a PERSONAL Treasury API key belonging to your verified Minecraft account. It is sent only over HTTPS, validated, encrypted, and never posted to Discord.</p><form method="post"><input name="treasury_token" type="password" autocomplete="off" required><button>Connect account</button></form><p><small>This link is single-use and expires shortly. Revoke the key in-game if you did not request this page.</small></p></html>`;
}

async function handleWebhook(req, res, raw) {
  let payload;
  try { payload = parseTreasuryJson(raw.toString("utf8")); } catch { return send(res, 400, { error: "INVALID_JSON" }); }
  const subscription = await subscriptionForTreasuryId(payload.subscriptionId);
  if (!subscription) return send(res, 404, { error: "UNKNOWN_SUBSCRIPTION" });
  const keys = parseEncryptionKeys();
  const secret = decryptToken({ version: subscription.secret_key_version, nonce: subscription.secret_nonce, tag: subscription.secret_tag, ciphertext: subscription.secret_ciphertext }, keys);
  const headers = {
    event: req.headers["x-treasury-event"],
    delivery: req.headers["x-treasury-delivery"],
    signature: req.headers["x-treasury-signature"],
  };
  if (!verifyTreasurySignature(raw, headers.signature, secret)) return send(res, 401, { error: "BAD_SIGNATURE" });
  if (headers.event !== payload.event || String(headers.delivery) !== String(payload.deliveryId)) return send(res, 400, { error: "HEADER_BODY_MISMATCH" });
  const result = await ingestDelivery({ subscription, headers, payload });
  return send(res, 202, { accepted: true, duplicate: Boolean(result.duplicate || result.duplicatePosting) });
}

async function handleConnect(req, res, token, raw) {
  const tokenHash = hashFingerprint(token);
  const row = (await pool.query(
    `SELECT ct.*,s.id shareholder_id,s.owner_uuid FROM connection_tokens ct JOIN shareholders s ON s.discord_id=ct.discord_id
     WHERE ct.token_hash=$1 AND ct.consumed_at IS NULL AND ct.expires_at>now()`, [tokenHash]
  )).rows[0];
  if (!row) return send(res, 410, connectPage("This connection link is expired or has already been used."), "text/html");
  if (req.method === "GET") return send(res, 200, connectPage(), "text/html");
  const params = new URLSearchParams(raw.toString("utf8"));
  const treasuryToken = params.get("treasury_token") || "";
  let cleanupClient = null;
  let cleanupWebhookId = null;
  let connectionCommitted = false;
  try {
    const { client, me } = await validatePersonalToken(treasuryToken, row.owner_uuid);
    const webhook = await client.createWebhook(`${publicBaseUrl()}/treasury/webhook`);
    cleanupClient = client;
    cleanupWebhookId = webhook.id;
    const keys = parseEncryptionKeys();
    const version = process.env.TOKEN_ENCRYPTION_ACTIVE_VERSION;
    const encryptedToken = encryptToken(treasuryToken, keys, version);
    const encryptedSecret = encryptToken(webhook.secret, keys, version);
    let oldToken = null;
    let previousWebhookId = null;
    try {
      await withTransaction(async (db) => {
      const consumed = await db.query(
        `UPDATE connection_tokens SET consumed_at=now()
         WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING token_hash`,
        [tokenHash]
      );
      if (!consumed.rowCount) throw new Error("Connection link was already consumed");
      const previous = (await db.query("SELECT webhook_id,token_key_version version,token_nonce nonce,token_tag tag,token_ciphertext ciphertext FROM shareholders WHERE id=$1 FOR UPDATE", [row.shareholder_id])).rows[0];
      oldToken = previous?.ciphertext ? decryptToken(previous, keys) : null;
      previousWebhookId = previous?.webhook_id || null;
      await db.query(
        `UPDATE shareholders SET account_id=$2,key_id=$3,token_key_version=$4,token_nonce=$5,token_tag=$6,token_ciphertext=$7,
         webhook_id=$8,webhook_secret_key_version=$4,webhook_secret_nonce=$9,webhook_secret_tag=$10,webhook_secret_ciphertext=$11,
         connected_at=now(),token_expires_at=now()+interval '180 days',disconnected_at=NULL WHERE id=$1`,
        [row.shareholder_id, me.accountId, me.keyId, version, encryptedToken.nonce, encryptedToken.tag, encryptedToken.ciphertext, webhook.id, encryptedSecret.nonce, encryptedSecret.tag, encryptedSecret.ciphertext]
      );
      if (previousWebhookId) await db.query("UPDATE treasury_subscriptions SET active=false WHERE treasury_webhook_id=$1", [previousWebhookId]);
      await db.query(
        `INSERT INTO treasury_subscriptions(scope,treasury_webhook_id,account_id,shareholder_id,guild_id,secret_key_version,secret_nonce,secret_tag,secret_ciphertext)
         VALUES('PERSONAL',$1,$2,$3,$4,$5,$6,$7,$8)`, [webhook.id, me.accountId, row.shareholder_id, row.guild_id, version, encryptedSecret.nonce, encryptedSecret.tag, encryptedSecret.ciphertext]
      );
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,metadata) VALUES('SHAREHOLDER',$1,'TOKEN_CONNECTED','SHAREHOLDER',$2,$3)", [row.discord_id, String(row.shareholder_id), { accountId: me.accountId, keyId: me.keyId, replacedWebhookId: previousWebhookId }]);
      });
      connectionCommitted = true;
      if (oldToken && previousWebhookId) await new TreasuryClient(oldToken).deleteWebhook(previousWebhookId).catch(() => {});
    } catch (error) {
      throw error;
    }
    return send(res, 200, connectPage("Treasury account connected. You can close this page."), "text/html");
  } catch (error) {
    if (!connectionCommitted && cleanupClient && cleanupWebhookId) await cleanupClient.deleteWebhook(cleanupWebhookId).catch(() => {});
    console.warn("Treasury connection rejected", redact(error));
    return send(res, 400, connectPage("Connection failed. Check that the key is PERSONAL, active, and belongs to your verified Minecraft account."), "text/html");
  }
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/readyz") {
        const state = await ready().catch((error) => ({ ok: false, error: redact(error) }));
        return send(res, state.ok ? 200 : 503, { ok: state.ok, missing: state.missing || [] });
      }
      const raw = req.method === "POST" ? await rawBody(req) : Buffer.alloc(0);
      if (req.method === "POST" && url.pathname === "/treasury/webhook") return await handleWebhook(req, res, raw);
      const match = /^\/connect\/([A-Za-z0-9_-]{32,128})$/.exec(url.pathname);
      if (match && (req.method === "GET" || req.method === "POST")) return await handleConnect(req, res, match[1], raw);
      return send(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      console.error("HTTP request failed", redact(error));
      return send(res, error.status || 500, { error: error.status ? error.message : "INTERNAL_ERROR" });
    }
  });
}

export async function issueConnectionLink(discordId, guildId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("DELETE FROM connection_tokens WHERE discord_id=$1 AND consumed_at IS NULL", [discordId]);
  await pool.query("INSERT INTO connection_tokens(token_hash,discord_id,guild_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')", [hashFingerprint(token), discordId, guildId]);
  return `${publicBaseUrl()}/connect/${token}`;
}
