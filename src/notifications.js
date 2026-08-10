import { pool, withTransaction } from "./database.js";
import { redact } from "./security.js";
import crypto from "node:crypto";

export async function enqueueNotification(db, { guildId = null, dedupeKey, eventType, message }) {
  await db.query(
    `INSERT INTO notification_outbox(guild_id,dedupe_key,event_type,message)
     VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING`,
    [guildId, dedupeKey, eventType, message]
  );
}

async function claim() {
  return withTransaction(async (db) => {
    const row = (await db.query(
      `SELECT n.*,g.finance_channel_id FROM notification_outbox n
       LEFT JOIN LATERAL (
         SELECT finance_channel_id FROM guild_config
         WHERE finance_channel_id IS NOT NULL AND (n.guild_id IS NULL OR guild_id=n.guild_id)
         ORDER BY updated_at DESC LIMIT 1
       ) g ON true
       WHERE n.status IN ('PENDING','FAILED') AND n.next_attempt_at<=now()
       ORDER BY n.created_at FOR UPDATE OF n SKIP LOCKED LIMIT 1`
    )).rows[0];
    if (!row) return null;
    await db.query("UPDATE notification_outbox SET status='CLAIMED',claimed_at=now(),attempt_count=attempt_count+1 WHERE id=$1", [row.id]);
    return row;
  });
}

export async function dispatchNotification(client) {
  const row = await claim();
  if (!row) return false;
  try {
    if (!row.finance_channel_id) throw new Error("Finance audit channel is not configured");
    const channel = await client.channels.fetch(row.finance_channel_id);
    if (!channel?.isTextBased()) throw new Error("Finance audit channel is unavailable");
    const marker = `RR-AUDIT-${crypto.createHash("sha256").update(row.dedupe_key).digest("hex").slice(0, 12)}`;
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    const alreadySent = recent?.some((message) => message.author.id === client.user.id && message.content.includes(marker));
    if (!alreadySent) await channel.send({ content: `${row.message}\nAudit ref: \`${marker}\``, allowedMentions: { parse: [] } });
    await pool.query("UPDATE notification_outbox SET status='SENT',claimed_at=NULL,sent_at=now(),last_error=NULL WHERE id=$1", [row.id]);
  } catch (error) {
    await pool.query(
      `UPDATE notification_outbox SET status='FAILED',claimed_at=NULL,last_error=$2,
       next_attempt_at=now()+LEAST(interval '1 hour',interval '15 seconds'*power(2,LEAST(attempt_count,8))) WHERE id=$1`,
      [row.id, redact(error)]
    );
  }
  return true;
}

export async function recoverStaleNotifications() {
  const result = await pool.query(
    `UPDATE notification_outbox SET status='FAILED',claimed_at=NULL,next_attempt_at=now(),
     last_error='Recovered stale notification claim after restart'
     WHERE status='CLAIMED' AND claimed_at<now()-interval '2 minutes' RETURNING id`
  );
  return result.rowCount;
}

export async function enqueueExpiryWarnings() {
  const rows = (await pool.query(
    `SELECT id,current_ign,token_expires_at FROM shareholders
     WHERE disconnected_at IS NULL AND token_ciphertext IS NOT NULL
       AND token_expires_at<=now()+interval '30 days'`
  )).rows;
  const day = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    await enqueueNotification(pool, {
      dedupeKey: `TOKEN_EXPIRY:${row.id}:${day}`,
      eventType: "TOKEN_EXPIRY",
      message: `Treasury connection warning: ${row.current_ign}'s key expires at ${new Date(row.token_expires_at).toISOString()}. Rotate it with /finance connect.`,
    });
  }
}
