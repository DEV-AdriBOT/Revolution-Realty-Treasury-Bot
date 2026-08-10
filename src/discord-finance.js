import crypto from "node:crypto";
import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { pool, withTransaction } from "./database.js";
import { issueConnectionLink } from "./http-server.js";
import { TreasuryClient, validateBusinessAccount } from "./treasury-client.js";
import { parseCents, formatCents, validateAllocations } from "./money.js";
import { reconcileAccounts } from "./jobs.js";
import { decryptToken, encryptToken, hashFingerprint, parseEncryptionKeys } from "./security.js";
import { matchRefundByManager } from "./finance-repository.js";
import { publicBaseUrl } from "./public-url.js";

const pendingOwnership = new Map();

export const propertyCommand = new SlashCommandBuilder().setName("property").setDescription("Manage Revolution Realty properties")
  .addSubcommand((s) => s.setName("list").setDescription("List properties"))
  .addSubcommand((s) => s.setName("view").setDescription("View a property").addStringOption((o) => o.setName("region").setDescription("Region ID").setRequired(true)))
  .addSubcommand((s) => s.setName("add").setDescription("Add a disabled property").addStringOption((o) => o.setName("region").setDescription("Region ID").setRequired(true)).addUserOption((o) => o.setName("landlord").setDescription("Verified landlord").setRequired(true)).addStringOption((o) => o.setName("shares").setDescription("Discord IDs and percentages, e.g. 123=80,456=20").setRequired(true)))
  .addSubcommand((s) => s.setName("landlord").setDescription("Change the in-game landlord for new events").addStringOption((o) => o.setName("region").setDescription("Region ID").setRequired(true)).addUserOption((o) => o.setName("shareholder").setDescription("Verified shareholder").setRequired(true)))
  .addSubcommand((s) => s.setName("ownership").setDescription("Replace the complete ownership split").addStringOption((o) => o.setName("region").setDescription("Region ID").setRequired(true)).addStringOption((o) => o.setName("shares").setDescription("Discord IDs and percentages, e.g. 123=50,456=50").setRequired(true)).addStringOption((o) => o.setName("reason").setDescription("Reason for change").setRequired(true)))
  .addSubcommand((s) => s.setName("enable").setDescription("Enable new financial events").addStringOption((o) => o.setName("region").setDescription("Region ID").setRequired(true)).addBooleanOption((o) => o.setName("confirm_review").setDescription("Confirm a REVIEW_REQUIRED merge outcome").setRequired(false)))
  .addSubcommand((s) => s.setName("disable").setDescription("Disable new financial events").addStringOption((o) => o.setName("region").setDescription("Region ID").setRequired(true)));

export const financeCommand = new SlashCommandBuilder().setName("finance").setDescription("Treasury finance operations")
  .addSubcommand((s) => s.setName("status").setDescription("Finance status and kill switch"))
  .addSubcommand((s) => s.setName("emergency-disable").setDescription("Immediately latch the database transfer kill switch").addStringOption((o) => o.setName("confirm").setDescription("Type DISABLE").setRequired(true)))
  .addSubcommand((s) => s.setName("clear-emergency").setDescription("Clear the latch; restart is still required to enable transfers").addStringOption((o) => o.setName("confirm").setDescription("Type CLEAR").setRequired(true)))
  .addSubcommand((s) => s.setName("account").setDescription("Validate and select the business account").addStringOption((o) => o.setName("account_id").setDescription("Treasury business account ID").setRequired(true)))
  .addSubcommand((s) => s.setName("connect").setDescription("Get a private one-time Treasury connection link"))
  .addSubcommand((s) => s.setName("disconnect").setDescription("Disconnect Treasury and erase encrypted credentials"))
  .addSubcommand((s) => s.setName("connections").setDescription("Connection and expiry status"))
  .addSubcommand((s) => s.setName("statement").setDescription("View your own rental distributions and debt recovery"))
  .addSubcommand((s) => s.setName("holds").setDescription("Pending seven-day holds"))
  .addSubcommand((s) => s.setName("payouts").setDescription("Payout operation status"))
  .addSubcommand((s) => s.setName("refunds").setDescription("Refund and reimbursement queue"))
  .addSubcommand((s) => s.setName("debts").setDescription("Your debts or all debts for managers"))
  .addSubcommand((s) => s.setName("ledger").setDescription("Recent balanced ledger events"))
  .addSubcommand((s) => s.setName("reconcile").setDescription("Run transaction-feed reconciliation"))
  .addSubcommand((s) => s.setName("retry").setDescription("Retry a failed operation").addIntegerOption((o) => o.setName("operation_id").setDescription("Operation ID").setRequired(true)))
  .addSubcommand((s) => s.setName("match-refund").setDescription("Explicitly match a reviewed refund to a compatible rental").addIntegerOption((o) => o.setName("refund_id").setDescription("Refund ID").setRequired(true)).addIntegerOption((o) => o.setName("rental_id").setDescription("Compatible rental ID").setRequired(true)))
  .addSubcommand((s) => s.setName("reserve-deposit").setDescription("Classify an exact imported business deposit as refund reserve").addIntegerOption((o) => o.setName("posting_id").setDescription("Internal posting ID from finance ledger/reconciliation").setRequired(true)))
  .addSubcommand((s) => s.setName("fund-landlord").setDescription("Prepare a landlord account for an in-game refund").addUserOption((o) => o.setName("landlord").setDescription("Verified landlord").setRequired(true)).addStringOption((o) => o.setName("amount").setDescription("Exact decimal amount").setRequired(true)).addStringOption((o) => o.setName("reference").setDescription("Unique manager reference").setRequired(true)));

export const leaseholdCommand = new SlashCommandBuilder().setName("leasehold").setDescription("Permanent leasehold management")
  .addSubcommand((s) => s.setName("create").setDescription("Create permanent leasehold billing").addStringOption((o) => o.setName("region").setDescription("Region").setRequired(true)).addStringOption((o) => o.setName("payer_uuid").setDescription("Verified payer UUID").setRequired(true)).addStringOption((o) => o.setName("payer_ign").setDescription("Current payer IGN").setRequired(true)).addStringOption((o) => o.setName("fee").setDescription("Exact decimal fee").setRequired(true)).addIntegerOption((o) => o.setName("interval_days").setDescription("Billing interval days").setRequired(true)).addIntegerOption((o) => o.setName("contract_id").setDescription("Existing contract ID").setRequired(false)))
  .addSubcommand((s) => s.setName("view").setDescription("View permanent leasehold").addStringOption((o) => o.setName("region").setDescription("Region").setRequired(true)))
  .addSubcommand((s) => s.setName("update").setDescription("Update future fee and interval").addStringOption((o) => o.setName("region").setDescription("Region").setRequired(true)).addStringOption((o) => o.setName("fee").setDescription("Exact decimal fee").setRequired(true)).addIntegerOption((o) => o.setName("interval_days").setDescription("Billing interval days").setRequired(true)))
  .addSubcommand((s) => s.setName("close").setDescription("Close permanent leasehold billing").addStringOption((o) => o.setName("region").setDescription("Region").setRequired(true)))
  .addSubcommand((s) => s.setName("payments").setDescription("List permanent leasehold payments").addStringOption((o) => o.setName("region").setDescription("Optional region").setRequired(false)));

function regionOf(interaction) { return interaction.options.getString("region").trim().toUpperCase(); }
function lineRows(rows, formatter) { return rows.length ? rows.map(formatter).join("\n").slice(0, 1900) : "No records."; }

async function shareholderByDiscord(db, discordId) {
  const row = (await db.query("SELECT * FROM shareholders WHERE discord_id=$1", [discordId])).rows[0];
  if (!row) throw new Error(`Discord user ${discordId} must complete IGN verification first`);
  return row;
}

async function parseShares(db, text) {
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  const shares = [];
  for (const part of parts) {
    const match = /^(?:<@!?)?(\d+)>?=(\d+(?:\.\d{1,2})?)$/.exec(part);
    if (!match) throw new Error("Shares must use DiscordID=percent pairs");
    const shareholder = await shareholderByDiscord(db, match[1]);
    const basisPoints = Math.round(Number(match[2]) * 100);
    shares.push({ shareholderId: shareholder.id, discordId: shareholder.discord_id, basisPoints });
  }
  validateAllocations(shares);
  return shares;
}

export async function handleFinanceInteraction(interaction, isManager) {
  if (interaction.isButton() && interaction.customId.startsWith("finance_confirm_ownership_")) {
    const key = interaction.customId.slice("finance_confirm_ownership_".length);
    const pending = pendingOwnership.get(key);
    if (!pending || pending.expires < Date.now() || pending.actor !== interaction.user.id) return interaction.reply({ content: "This ownership preview expired.", ephemeral: true });
    if (!isManager(interaction.member, interaction.guild.id)) return interaction.reply({ content: "Manager access required.", ephemeral: true });
    await withTransaction(async (db) => {
      const property = (await db.query("SELECT * FROM properties WHERE region=$1 FOR UPDATE", [pending.region])).rows[0];
      const next = Number((await db.query("SELECT COALESCE(max(version),0)+1 n FROM ownership_versions WHERE property_id=$1", [property.id])).rows[0].n);
      const version = (await db.query("INSERT INTO ownership_versions(property_id,version,created_by,reason) VALUES($1,$2,$3,$4) RETURNING id", [property.id, next, interaction.user.id, pending.reason])).rows[0];
      for (const share of pending.shares) await db.query("INSERT INTO ownership_allocations(ownership_version_id,shareholder_id,basis_points) VALUES($1,$2,$3)", [version.id, share.shareholderId, share.basisPoints]);
      if (!(await db.query("SELECT ownership_total_is_10000($1) ok", [version.id])).rows[0].ok) throw new Error("Ownership total failed database validation");
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,after_data) VALUES('DISCORD',$1,'OWNERSHIP_CHANGED','PROPERTY',$2,$3)", [interaction.user.id, String(property.id), { version: next, shares: pending.shares }]);
    }, "SERIALIZABLE");
    pendingOwnership.delete(key);
    return interaction.update({ content: `Ownership for ${pending.region} was replaced atomically. New rentals use the new snapshot; existing rentals are unchanged.`, components: [] });
  }
  if (!interaction.isChatInputCommand() || !["property", "finance", "leasehold"].includes(interaction.commandName)) return false;
  const manager = isManager(interaction.member, interaction.guild.id);
  const sub = interaction.options.getSubcommand();
  try {
    if (interaction.commandName === "property") return await handleProperty(interaction, sub, manager);
    if (interaction.commandName === "finance") return await handleFinance(interaction, sub, manager);
    return await handleLeasehold(interaction, sub, manager);
  } catch (error) {
    const message = `Request rejected: ${error.message}`;
    if (interaction.deferred || interaction.replied) return interaction.editReply(message);
    return interaction.reply({ content: message, ephemeral: true });
  }
}

async function handleProperty(i, sub, manager) {
  if (sub === "list") {
    const rows = (await pool.query("SELECT region,status,property_type FROM properties ORDER BY region")).rows;
    return i.reply({ content: lineRows(rows, (r) => `${r.region} — ${r.status} — ${r.property_type}`), ephemeral: true });
  }
  if (sub === "view") {
    const rows = (await pool.query(`SELECT p.region,p.status,p.property_type,landlord.current_ign landlord,ov.version,s.current_ign,oa.basis_points FROM properties p JOIN shareholders landlord ON landlord.id=p.landlord_shareholder_id JOIN LATERAL(SELECT * FROM ownership_versions WHERE property_id=p.id ORDER BY version DESC LIMIT 1) ov ON true JOIN ownership_allocations oa ON oa.ownership_version_id=ov.id JOIN shareholders s ON s.id=oa.shareholder_id WHERE p.region=$1 ORDER BY s.current_ign`, [regionOf(i)])).rows;
    return i.reply({ content: lineRows(rows, (r, index) => `${index ? "" : `${r.region} — ${r.status} — landlord ${r.landlord} — ownership v${r.version}\n`}${r.current_ign}: ${r.basis_points / 100}%`), ephemeral: true });
  }
  if (!manager) throw new Error("Manager access required");
  const region = regionOf(i);
  if (sub === "enable" || sub === "disable") {
    const status = sub === "enable" ? "ACTIVE" : "DISABLED";
    const confirmReview = i.options.getBoolean("confirm_review") === true;
    await withTransaction(async (db) => {
      const before = (await db.query("SELECT id,status FROM properties WHERE region=$1 FOR UPDATE", [region])).rows[0];
      if (!before || (before.status === "REVIEW_REQUIRED" && !confirmReview)) throw new Error("Property not found or requires explicit merge review");
      await db.query("UPDATE properties SET status=$2,updated_at=now() WHERE id=$1", [before.id, status]);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'PROPERTY_STATUS','PROPERTY',$2,$3,$4)", [i.user.id, String(before.id), { status: before.status }, { status }]);
    });
    return i.reply({ content: `${region} is now ${status}.`, ephemeral: true });
  }
  if (sub === "landlord") {
    const shareholder = await shareholderByDiscord(pool, i.options.getUser("shareholder").id);
    await withTransaction(async (db) => {
      const before = (await db.query("SELECT id,landlord_shareholder_id FROM properties WHERE region=$1 FOR UPDATE", [region])).rows[0];
      if (!before) throw new Error("Property not found");
      await db.query("UPDATE properties SET landlord_shareholder_id=$2,updated_at=now() WHERE id=$1", [before.id, shareholder.id]);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'LANDLORD_CHANGED','PROPERTY',$2,$3,$4)", [i.user.id, String(before.id), { shareholderId: before.landlord_shareholder_id }, { shareholderId: shareholder.id }]);
    });
    return i.reply({ content: `New ${region} Realty events expect landlord ${shareholder.current_ign}; economic ownership is unchanged.`, ephemeral: true });
  }
  if (sub === "add") {
    const landlord = await shareholderByDiscord(pool, i.options.getUser("landlord").id);
    const shares = await parseShares(pool, i.options.getString("shares"));
    await withTransaction(async (db) => {
      const property = (await db.query("INSERT INTO properties(region,landlord_shareholder_id,status) VALUES($1,$2,'DISABLED') RETURNING id", [region, landlord.id])).rows[0];
      const version = (await db.query("INSERT INTO ownership_versions(property_id,version,created_by,reason) VALUES($1,1,$2,'Property added') RETURNING id", [property.id, i.user.id])).rows[0];
      for (const share of shares) await db.query("INSERT INTO ownership_allocations VALUES($1,$2,$3)", [version.id, share.shareholderId, share.basisPoints]);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,after_data) VALUES('DISCORD',$1,'PROPERTY_ADDED','PROPERTY',$2,$3)", [i.user.id, String(property.id), { region, status: "DISABLED", landlordId: landlord.id, shares }]);
    });
    return i.reply({ content: `${region} added as DISABLED. Review it, then use /property enable.`, ephemeral: true });
  }
  const shares = await parseShares(pool, i.options.getString("shares"));
  const current = (await pool.query(`SELECT s.current_ign,oa.basis_points FROM properties p JOIN LATERAL(SELECT id FROM ownership_versions WHERE property_id=p.id ORDER BY version DESC LIMIT 1) ov ON true JOIN ownership_allocations oa ON oa.ownership_version_id=ov.id JOIN shareholders s ON s.id=oa.shareholder_id WHERE p.region=$1`, [region])).rows;
  if (!current.length) throw new Error("Property not found");
  const key = crypto.randomBytes(12).toString("hex");
  pendingOwnership.set(key, { actor: i.user.id, region, shares, reason: i.options.getString("reason"), expires: Date.now() + 5 * 60 * 1000 });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`finance_confirm_ownership_${key}`).setLabel("Confirm complete replacement").setStyle(ButtonStyle.Danger));
  return i.reply({ content: `Ownership preview for ${region}\nOld: ${current.map((x) => `${x.current_ign} ${x.basis_points / 100}%`).join(", ")}\nNew: ${shares.map((x) => `<@${x.discordId}> ${x.basisPoints / 100}%`).join(", ")}\nThis affects new rentals only.`, components: [row], ephemeral: true });
}

async function handleFinance(i, sub, manager) {
  if (sub === "connect") {
    await shareholderByDiscord(pool, i.user.id);
    return i.reply({ content: `Your single-use Treasury connection link (expires in 10 minutes):\n${await issueConnectionLink(i.user.id, i.guild.id)}`, ephemeral: true });
  }
  if (sub === "disconnect") {
    const shareholder = await shareholderByDiscord(pool, i.user.id);
    let webhookDeleted = false;
    if (shareholder.token_ciphertext && shareholder.webhook_id) {
      try {
        const token = decryptToken({ version: shareholder.token_key_version, nonce: shareholder.token_nonce, tag: shareholder.token_tag, ciphertext: shareholder.token_ciphertext }, parseEncryptionKeys());
        await new TreasuryClient(token).deleteWebhook(shareholder.webhook_id);
        webhookDeleted = true;
      } catch { webhookDeleted = false; }
    }
    await withTransaction(async (db) => {
      await db.query("UPDATE treasury_subscriptions SET active=false WHERE treasury_webhook_id=$1", [shareholder.webhook_id]);
      await db.query(`UPDATE shareholders SET account_id=NULL,key_id=NULL,token_key_version=NULL,token_nonce=NULL,token_tag=NULL,token_ciphertext=NULL,
        token_expires_at=NULL,webhook_id=NULL,webhook_secret_key_version=NULL,webhook_secret_nonce=NULL,webhook_secret_tag=NULL,webhook_secret_ciphertext=NULL,
        disconnected_at=now() WHERE id=$1`, [shareholder.id]);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)", ["SHAREHOLDER", i.user.id, "TOKEN_DISCONNECTED", "SHAREHOLDER", String(shareholder.id), { webhookDeleted }]);
    });
    return i.reply({ content: `Treasury credentials erased.${webhookDeleted ? " Webhook deleted." : " Revoke the old key in-game; remote webhook deletion could not be confirmed."}`, ephemeral: true });
  }
  if (sub === "debts" && !manager) {
    const rows = (await pool.query("SELECT d.* FROM shareholder_debts d JOIN shareholders s ON s.id=d.shareholder_id WHERE s.discord_id=$1 ORDER BY d.created_at DESC", [i.user.id])).rows;
    return i.reply({ content: lineRows(rows, (r) => `Debt #${r.id}: ${formatCents(r.outstanding_cents)} DC — ${r.status}`), ephemeral: true });
  }
  if (sub === "connections" && !manager) {
    const shareholder = await shareholderByDiscord(pool, i.user.id);
    const connected = shareholder.connected_at && !shareholder.disconnected_at && shareholder.token_ciphertext;
    return i.reply({ content: `Treasury connection: ${connected ? "connected" : "disconnected"}${shareholder.token_expires_at ? `\nEstimated rotation deadline: ${new Date(shareholder.token_expires_at).toISOString()}` : ""}`, ephemeral: true });
  }
  if (sub === "statement") {
    const shareholder = await shareholderByDiscord(pool, i.user.id);
    const rows = (await pool.query(
      `SELECT r.id,p.region,ra.gross_entitlement_cents,ra.refund_liability_cents,ra.debt_recovered_cents,ra.paid_cents,ra.status
       FROM rental_allocations ra JOIN rentals r ON r.id=ra.rental_id JOIN properties p ON p.id=r.property_id
       WHERE ra.shareholder_id=$1 ORDER BY r.settled_at DESC LIMIT 20`, [shareholder.id]
    )).rows;
    const debt = BigInt((await pool.query("SELECT COALESCE(sum(outstanding_cents),0) total FROM shareholder_debts WHERE shareholder_id=$1 AND status IN ('OPEN','PARTIAL')", [shareholder.id])).rows[0].total);
    return i.reply({ content: `Outstanding debt: ${formatCents(debt)} DC\n${lineRows(rows, (r) => `Rental #${r.id} ${r.region}: entitlement ${formatCents(r.gross_entitlement_cents)}, refunds ${formatCents(r.refund_liability_cents)}, debt recovered ${formatCents(r.debt_recovered_cents)}, paid ${formatCents(r.paid_cents)} — ${r.status}`)}`, ephemeral: true });
  }
  if (!manager) throw new Error("Manager access required");
  if (sub === "status") {
    const cfg = (await pool.query("SELECT * FROM guild_config WHERE guild_id=$1", [i.guild.id])).rows[0];
    const counts = (await pool.query("SELECT status,count(*) FROM monetary_operations GROUP BY status ORDER BY status")).rows;
    return i.reply({ content: `Mode: ${cfg?.finance_mode || "disabled"}\nEmergency latch: ${cfg?.emergency_disabled ? "ACTIVE" : "clear"}\nBusiness account: ${cfg?.business_account_id || "not configured"}\n${counts.map((x) => `${x.status}: ${x.count}`).join("\n") || "No operations."}`, ephemeral: true });
  }
  if (sub === "emergency-disable") {
    if (i.options.getString("confirm") !== "DISABLE") throw new Error("Confirmation must be exactly DISABLE");
    await withTransaction(async (db) => {
      const before = (await db.query("SELECT finance_mode,emergency_disabled FROM guild_config WHERE guild_id=$1 FOR UPDATE", [i.guild.id])).rows[0];
      if (!before) throw new Error("Guild finance configuration is unavailable");
      await db.query("UPDATE guild_config SET finance_mode='disabled',emergency_disabled=true,updated_at=now() WHERE guild_id=$1", [i.guild.id]);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'EMERGENCY_DISABLED','GUILD',$2,$3,$4)", [i.user.id, i.guild.id, before, { financeMode: "disabled", emergencyDisabled: true }]);
    });
    return i.reply({ content: "Emergency latch is active. The worker will claim no new transfers; webhooks and reconciliation remain available.", ephemeral: true });
  }
  if (sub === "clear-emergency") {
    if (i.options.getString("confirm") !== "CLEAR") throw new Error("Confirmation must be exactly CLEAR");
    await withTransaction(async (db) => {
      const before = (await db.query("SELECT finance_mode,emergency_disabled FROM guild_config WHERE guild_id=$1 FOR UPDATE", [i.guild.id])).rows[0];
      if (!before?.emergency_disabled) throw new Error("Emergency latch is not active");
      await db.query("UPDATE guild_config SET emergency_disabled=false,finance_mode='disabled',updated_at=now() WHERE guild_id=$1", [i.guild.id]);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'EMERGENCY_CLEARED','GUILD',$2,$3,$4)", [i.user.id, i.guild.id, before, { financeMode: "disabled", emergencyDisabled: false }]);
    });
    return i.reply({ content: "Emergency latch cleared, but finance remains disabled. Review and restart with the intended server-side FINANCE_MODE to resume.", ephemeral: true });
  }
  if (sub === "account") {
    const id = i.options.getString("account_id");
    if (!/^\d+$/.test(id)) throw new Error("Account ID must be numeric");
    if (!process.env.TREASURY_BUSINESS_TOKEN) throw new Error("TREASURY_BUSINESS_TOKEN is not configured");
    const { account } = await validateBusinessAccount(process.env.TREASURY_BUSINESS_TOKEN, id);
    const existingWebhook = (await pool.query("SELECT * FROM treasury_subscriptions WHERE scope='BUSINESS' AND active AND (guild_id=$1 OR guild_id IS NULL) ORDER BY created_at DESC LIMIT 1", [i.guild.id])).rows[0];
    let createdWebhook = null;
    if (!existingWebhook) {
      const client = new TreasuryClient(process.env.TREASURY_BUSINESS_TOKEN);
      createdWebhook = await client.createWebhook(`${publicBaseUrl()}/treasury/webhook`);
      try {
        const keys = parseEncryptionKeys();
        const version = process.env.TOKEN_ENCRYPTION_ACTIVE_VERSION;
        createdWebhook.encryptedSecret = encryptToken(createdWebhook.secret, keys, version);
        createdWebhook.keyVersion = version;
      } catch (error) {
        await client.deleteWebhook(createdWebhook.id).catch(() => {});
        throw error;
      }
    }
    try {
      await withTransaction(async (db) => {
        const previousAccount = (await db.query("SELECT business_account_id FROM guild_config WHERE guild_id=$1 FOR UPDATE", [i.guild.id])).rows[0]?.business_account_id || null;
        await db.query(`INSERT INTO guild_config(guild_id,business_account_id) VALUES($1,$2) ON CONFLICT(guild_id) DO UPDATE SET business_account_id=excluded.business_account_id,updated_at=now()`, [i.guild.id, id]);
        await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'BUSINESS_ACCOUNT_CHANGED','GUILD',$2,$3,$4)", [i.user.id, i.guild.id, { accountId: previousAccount }, { accountId: id }]);
        if (existingWebhook) {
          await db.query("UPDATE treasury_subscriptions SET guild_id=$2,account_id=$3 WHERE id=$1", [existingWebhook.id, i.guild.id, id]);
        } else {
          const encrypted = createdWebhook.encryptedSecret;
          await db.query(`INSERT INTO treasury_subscriptions(scope,treasury_webhook_id,account_id,firm_id,guild_id,secret_key_version,secret_nonce,secret_tag,secret_ciphertext)
            VALUES('BUSINESS',$1,$2,$3,$4,$5,$6,$7,$8)`, [createdWebhook.id, id, createdWebhook.firmId || null, i.guild.id, createdWebhook.keyVersion, encrypted.nonce, encrypted.tag, encrypted.ciphertext]);
        }
      });
    } catch (error) {
      if (createdWebhook) await new TreasuryClient(process.env.TREASURY_BUSINESS_TOKEN).deleteWebhook(createdWebhook.id).catch(() => {});
      throw error;
    }
    return i.reply({ content: `Validated and selected active firm account ${account.accountId} (${account.displayName}). Existing workflows retain their original account.`, ephemeral: true });
  }
  if (sub === "connections") {
    const rows = (await pool.query("SELECT current_ign,connected_at,token_expires_at,disconnected_at FROM shareholders ORDER BY current_ign")).rows;
    return i.reply({ content: lineRows(rows, (r) => `${r.current_ign}: ${r.connected_at && !r.disconnected_at ? "connected" : "disconnected"}${r.token_expires_at ? `, expires ${new Date(r.token_expires_at).toISOString()}` : ""}`), ephemeral: true });
  }
  const queries = {
    holds: ["SELECT r.id,p.region,r.gross_cents,r.hold_until,r.sweep_status,r.release_status FROM rentals r JOIN properties p ON p.id=r.property_id ORDER BY r.hold_until DESC LIMIT 30", (r) => `#${r.id} ${r.region} ${formatCents(r.gross_cents)} DC — sweep ${r.sweep_status}, release ${r.release_status}, until ${new Date(r.hold_until).toISOString()}`],
    payouts: ["SELECT * FROM monetary_operations WHERE operation_type='PAYOUT' ORDER BY created_at DESC LIMIT 30", (r) => `#${r.id} ${formatCents(r.amount_cents)} DC — ${r.status}`],
    refunds: ["SELECT f.*,p.region FROM refunds f JOIN properties p ON p.id=f.property_id ORDER BY f.created_at DESC LIMIT 30", (r) => `#${r.id} ${r.region} ${formatCents(r.amount_cents)} DC — match ${r.matched_status}, reimbursement ${r.reimbursement_status}`],
    debts: ["SELECT d.*,s.current_ign FROM shareholder_debts d JOIN shareholders s ON s.id=d.shareholder_id ORDER BY d.created_at DESC LIMIT 30", (r) => `#${r.id} ${r.current_ign} ${formatCents(r.outstanding_cents)} DC — ${r.status}`],
    ledger: ["SELECT lt.*,COALESCE(sum(le.debit_cents),0) total FROM ledger_transactions lt JOIN ledger_entries le ON le.ledger_transaction_id=lt.id GROUP BY lt.id ORDER BY lt.created_at DESC LIMIT 30", (r) => `#${r.id} ${r.event_type} ${formatCents(r.total)} DC — ${r.description}`],
  };
  if (queries[sub]) {
    const [query, formatter] = queries[sub];
    return i.reply({ content: lineRows((await pool.query(query)).rows, formatter), ephemeral: true });
  }
  if (sub === "reconcile") {
    await i.deferReply({ ephemeral: true });
    return i.editReply(`Reconciliation finished; imported ${await reconcileAccounts()} new postings.`);
  }
  if (sub === "retry") {
    const operationId = i.options.getInteger("operation_id");
    const result = await withTransaction(async (db) => {
      const operation = (await db.query("SELECT * FROM monetary_operations WHERE id=$1 FOR UPDATE", [operationId])).rows[0];
      if (!operation || !["FAILED", "UNKNOWN", "SHADOW"].includes(operation.status)) throw new Error("Operation is not retryable");
      if (operation.status === "SHADOW") {
        const mode = (await db.query("SELECT finance_mode FROM guild_config WHERE guild_id=$1", [i.guild.id])).rows[0]?.finance_mode;
        if (mode !== "live" || process.env.FINANCE_MODE !== "live") throw new Error("Shadow operations can only be released while both database and process finance mode are live");
      }
      const updated = (await db.query("UPDATE monetary_operations SET status='PENDING',attempt_count=0,automatic_retry=true,next_attempt_at=now(),last_error=NULL WHERE id=$1 RETURNING id", [operationId])).rows[0];
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'OPERATION_RETRIED','MONETARY_OPERATION',$2,$3,$4)", [i.user.id, String(operationId), { status: operation.status }, { status: "PENDING" }]);
      return updated;
    });
    return i.reply({ content: `Operation ${result.id} queued with its existing idempotency key.`, ephemeral: true });
  }
  if (sub === "match-refund") {
    const refundId = i.options.getInteger("refund_id");
    const rentalId = i.options.getInteger("rental_id");
    await withTransaction(async (db) => {
      const { refund } = await matchRefundByManager(db, refundId, rentalId);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'REFUND_MATCHED','REFUND',$2,$3,$4)", [i.user.id, String(refundId), { matchedStatus: refund.matched_status, rentalId: null }, { matchedStatus: "MATCHED", rentalId }]);
    }, "SERIALIZABLE");
    return i.reply({ content: `Refund ${refundId} matched to rental ${rentalId}. The original ownership snapshot now governs reimbursement and debt.`, ephemeral: true });
  }
  if (sub === "reserve-deposit") {
    const postingId = i.options.getInteger("posting_id");
    const amount = await withTransaction(async (db) => {
      const posting = (await db.query(
        `SELECT tp.*,ut.review_status FROM treasury_postings tp
         JOIN unclassified_transactions ut ON ut.posting_id=tp.id
         WHERE tp.id=$1 FOR UPDATE OF tp,ut`, [postingId]
      )).rows[0];
      const config = (await db.query("SELECT business_account_id FROM guild_config WHERE guild_id=$1", [i.guild.id])).rows[0];
      if (!posting || posting.review_status !== "OPEN") throw new Error("Posting is not an open unclassified item");
      if (!config?.business_account_id || String(posting.account_id) !== String(config.business_account_id)) throw new Error("Posting is not on the active business account");
      if (BigInt(posting.amount_cents) <= 0n) throw new Error("Reserve contributions must be exact incoming deposits");
      await db.query("UPDATE treasury_postings SET classification='RESERVE_DEPOSIT' WHERE id=$1", [postingId]);
      await db.query("UPDATE unclassified_transactions SET review_status='RESOLVED' WHERE posting_id=$1", [postingId]);
      const ledger = (await db.query("INSERT INTO ledger_transactions(event_type,workflow_type,workflow_id,description) VALUES('RESERVE_DEPOSIT','TREASURY_POSTING',$1,'Manager-classified refund reserve contribution') RETURNING id", [postingId])).rows[0];
      await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,debit_cents) VALUES($1,'TREASURY_CASH',$2)", [ledger.id, posting.amount_cents]);
      await db.query("INSERT INTO ledger_entries(ledger_transaction_id,bucket,credit_cents) VALUES($1,'REFUND_RESERVE',$2)", [ledger.id, posting.amount_cents]);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'RESERVE_DEPOSIT_CLASSIFIED','TREASURY_POSTING',$2,$3,$4)", [i.user.id, String(postingId), { classification: posting.classification, reviewStatus: posting.review_status }, { classification: "RESERVE_DEPOSIT", reviewStatus: "RESOLVED" }]);
      return BigInt(posting.amount_cents);
    });
    return i.reply({ content: `Posting ${postingId} classified as a ${formatCents(amount)} DC refund-reserve contribution.`, ephemeral: true });
  }
  const landlord = await shareholderByDiscord(pool, i.options.getUser("landlord").id);
  const amount = parseCents(i.options.getString("amount"));
  if (amount <= 0n) throw new Error("Amount must be positive");
  const reference = i.options.getString("reference").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(reference)) throw new Error("Reference must be 3-32 letters, numbers, underscore or dash");
  const cfg = (await pool.query("SELECT business_account_id,finance_mode FROM guild_config WHERE guild_id=$1", [i.guild.id])).rows[0];
  if (!cfg?.business_account_id) throw new Error("Business account is not configured");
  const memo = `RR:FUND:${reference}`;
  await withTransaction(async (db) => {
    const operation = (await db.query(`INSERT INTO monetary_operations(operation_type,workflow_type,workflow_id,leg_key,source_account_id,destination_uuid,amount_cents,memo,idempotency_key,request_fingerprint,status) VALUES('FUND_LANDLORD','MANUAL',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [landlord.id, reference, cfg.business_account_id, landlord.owner_uuid, amount.toString(), memo, `rr-fund-${reference.toLowerCase()}`, hashFingerprint(`${cfg.business_account_id}:${landlord.owner_uuid}:${amount}:${memo}`), cfg.finance_mode === "live" ? "PENDING" : "SHADOW"])).rows[0];
    await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,after_data) VALUES('DISCORD',$1,'LANDLORD_FUNDING_CREATED','MONETARY_OPERATION',$2,$3)", [i.user.id, String(operation.id), { landlordId: landlord.id, amountCents: amount.toString(), reference }]);
  });
  return i.reply({ content: `Landlord funding operation ${reference} created for ${formatCents(amount)} DC in ${cfg.finance_mode} mode.`, ephemeral: true });
}

async function handleLeasehold(i, sub, manager) {
  if (!manager) throw new Error("Manager access required");
  const region = regionOf(i);
  if (sub === "view") {
    const rows = (await pool.query("SELECT l.*,p.region FROM leaseholds l JOIN properties p ON p.id=l.property_id WHERE p.region=$1", [region])).rows;
    return i.reply({ content: lineRows(rows, (r) => `${r.region}: payer ${r.payer_ign}, ${formatCents(r.fee_cents)} DC every ${r.interval_days} days, ref ${r.payment_reference}, ${r.status}`), ephemeral: true });
  }
  if (sub === "payments") {
    const filter = i.options.getString("region");
    const rows = (await pool.query(`SELECT c.*,p.region FROM leasehold_charges c JOIN leaseholds l ON l.id=c.leasehold_id JOIN properties p ON p.id=l.property_id ${filter ? "WHERE p.region=$1" : ""} ORDER BY c.due_at DESC LIMIT 30`, filter ? [filter.toUpperCase()] : [])).rows;
    return i.reply({ content: lineRows(rows, (r) => `${r.region} ${formatCents(r.amount_cents)} DC due ${new Date(r.due_at).toISOString()} — ${r.status}`), ephemeral: true });
  }
  if (sub === "close") {
    await withTransaction(async (db) => {
      const before = (await db.query("SELECT l.id,l.status FROM leaseholds l JOIN properties p ON p.id=l.property_id WHERE p.region=$1 FOR UPDATE OF l", [region])).rows[0];
      if (!before) throw new Error("Leasehold not found");
      await db.query("UPDATE leaseholds SET status='CLOSED',updated_at=now() WHERE id=$1", [before.id]);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'LEASEHOLD_CLOSED','LEASEHOLD',$2,$3,$4)", [i.user.id, String(before.id), { status: before.status }, { status: "CLOSED" }]);
    });
    return i.reply({ content: `${region} leasehold billing closed; history was retained.`, ephemeral: true });
  }
  const fee = parseCents(i.options.getString("fee"));
  const interval = i.options.getInteger("interval_days");
  if (fee <= 0n || interval <= 0) throw new Error("Fee and interval must be positive");
  if (sub === "update") {
    await withTransaction(async (db) => {
      const before = (await db.query("SELECT l.* FROM leaseholds l JOIN properties p ON p.id=l.property_id WHERE p.region=$1 AND l.status<>'CLOSED' FOR UPDATE OF l", [region])).rows[0];
      if (!before) throw new Error("Active leasehold not found");
      await db.query("UPDATE leaseholds SET fee_cents=$2,interval_days=$3,updated_at=now() WHERE id=$1", [before.id, fee.toString(), interval]);
      await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,before_data,after_data) VALUES('DISCORD',$1,'LEASEHOLD_UPDATED','LEASEHOLD',$2,$3,$4)", [i.user.id, String(before.id), { feeCents: before.fee_cents, intervalDays: before.interval_days }, { feeCents: fee.toString(), intervalDays: interval }]);
    });
    return i.reply({ content: `${region} future billing updated; existing charge history is unchanged.`, ephemeral: true });
  }
  const payerUuid = i.options.getString("payer_uuid").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payerUuid)) throw new Error("Payer UUID must be a canonical Minecraft UUID");
  const payerIgn = i.options.getString("payer_ign").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(payerIgn)) throw new Error("Payer IGN is invalid");
  const reference = `RR-LH-${region}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  await withTransaction(async (db) => {
    const property = (await db.query("UPDATE properties SET property_type='PERMANENT_LEASEHOLD' WHERE region=$1 RETURNING id", [region])).rows[0];
    if (!property) throw new Error("Property not found");
    const leasehold = (await db.query(`INSERT INTO leaseholds(property_id,payer_uuid,payer_ign,fee_cents,interval_days,payment_reference,next_due_at,contract_id,guild_id) VALUES($1,$2,$3,$4,$5,$6,now()+(interval '1 day'*$5),$7,$8) RETURNING *`, [property.id, payerUuid, payerIgn, fee.toString(), interval, reference, i.options.getInteger("contract_id"), i.guild.id])).rows[0];
    await db.query("INSERT INTO leasehold_charges(leasehold_id,period_start,due_at,amount_cents) VALUES($1,now(),$2,$3)", [leasehold.id, leasehold.next_due_at, fee.toString()]);
    await db.query("INSERT INTO audit_events(actor_type,actor_id,event_type,entity_type,entity_id,after_data) VALUES('DISCORD',$1,'LEASEHOLD_CREATED','LEASEHOLD',$2,$3)", [i.user.id, String(leasehold.id), { region, payerUuid, payerIgn, feeCents: fee.toString(), intervalDays: interval, reference }]);
  });
  return i.reply({ content: `${region} permanent leasehold created. Exact payment reference: ${reference}. All matching fees are company revenue.`, ephemeral: true });
}
