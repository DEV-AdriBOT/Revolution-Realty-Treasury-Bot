// ---------------------------------------------------------------------------
// Revolution Realty Discord and Treasury bot.
// Buy/Sell panel → private deal channel with Realtor/Manager roles → close.
// ---------------------------------------------------------------------------
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  AttachmentBuilder,
} from "discord.js";
import { config } from "./config.js";
import * as store from "./db.js";
import { pool, shutdownDatabase } from "./src/database.js";
import { createAppServer } from "./src/http-server.js";
import { startWorker } from "./src/worker.js";
import { startSchedulers } from "./src/jobs.js";
import { dispatchNotification, recoverStaleNotifications } from "./src/notifications.js";
import { propertyCommand, financeCommand, leaseholdCommand, handleFinanceInteraction } from "./src/discord-finance.js";
import { ensureGuildSetup } from "./setup.js";
import {
  panelEmbed,
  panelButtons,
  ticketWelcomeEmbed,
  closeButton,
  verifyConfirmButton,
  listingEmbed,
  helpEmbed,
  contractorWelcomeEmbed,
  contractorReviewButtons,
  contractorAdEmbed,
  staffPanelEmbed,
  staffPanelButtons,
} from "./embeds.js";
import {
  contractEmbed,
  contractButtons,
  allSigned,
  pdfAttachment,
  todayISO,
  plusDaysISO,
} from "./contracts.js";
import {
  verifyEnabled,
  newMemoCode,
  findVerificationPayment,
} from "./verify.js";

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const messageContentEnabled = process.env.ENABLE_MESSAGE_CONTENT_INTENT !== "false";
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    ...(messageContentEnabled ? [GatewayIntentBits.MessageContent] : []),
  ],
  partials: [Partials.Channel],
});

// Per-guild config (auto-setup) first, .env fallback.
const ENV_FALLBACK = {
  realtorRoleId: process.env.REALTOR_ROLE_ID,
  managerRoleId: process.env.MANAGER_ROLE_ID,
  ticketCategoryId: process.env.TICKET_CATEGORY_ID,
  contractArchiveChannelId: process.env.CONTRACT_ARCHIVE_CHANNEL_ID,
  verifiedRoleId: process.env.VERIFIED_ROLE_ID,
  contractorRoleId: process.env.CONTRACTOR_ROLE_ID,
  contractorsChannelId: process.env.CONTRACTORS_CHANNEL_ID,
  automodLogChannelId: process.env.AUTOMOD_LOG_CHANNEL_ID,
  collectionsRoleId: process.env.COLLECTIONS_ROLE_ID,
  paymentsDueChannelId: process.env.PAYMENTS_DUE_CHANNEL_ID,
  financeChannelId: process.env.FINANCE_CHANNEL_ID,
};
function gcfg(guildId, key) {
  const gc = store.getGuildConfig(guildId);
  return gc[key] ?? ENV_FALLBACK[key] ?? null;
}

// Is this member realtor/manager/admin (i.e. staff)?
function isStaff(member, guildId) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const realtor = gcfg(guildId, "realtorRoleId");
  const manager = gcfg(guildId, "managerRoleId");
  return (
    (realtor && member.roles.cache.has(realtor)) ||
    (manager && member.roles.cache.has(manager))
  );
}

// Manager-only (contractor approvals, etc.).
function isManager(member, guildId) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const manager = gcfg(guildId, "managerRoleId");
  return manager && member.roles.cache.has(manager);
}

// --- Bot-side raid guard: same message across many channels = cross-channel
// ad spam. Deletes the copies and times the user out. Returns true if handled.
const recentByUser = new Map(); // userId -> [{ content, channelId, messageId, at }]
async function raidGuard(msg) {
  const a = config.automod;
  if (!a.raidGuard) return false;
  if (isStaff(msg.member, msg.guild.id)) return false;
  const content = msg.content.trim().toLowerCase();
  if (content.length < 8) return false;

  const now = Date.now();
  const arr = (recentByUser.get(msg.author.id) || []).filter(
    (m) => now - m.at < a.raidWindowMs
  );
  arr.push({ content, channelId: msg.channel.id, messageId: msg.id, at: now });
  recentByUser.set(msg.author.id, arr);

  const same = arr.filter((m) => m.content === content);
  const channels = new Set(same.map((m) => m.channelId));
  if (channels.size < a.raidChannels) return false;

  // Raid detected: delete all copies + time out the user.
  for (const m of same) {
    const ch = await client.channels.fetch(m.channelId).catch(() => null);
    await ch?.messages?.delete(m.messageId).catch(() => {});
  }
  await msg.member?.timeout(a.raidTimeoutMins * 60 * 1000, "Cross-channel spam (raid guard)").catch(() => {});
  recentByUser.delete(msg.author.id);

  const logId = gcfg(msg.guild.id, "automodLogChannelId");
  if (logId) {
    const ch = await client.channels.fetch(logId).catch(() => null);
    ch?.send?.(
      `🚨 **Raid guard:** timed out <@${msg.author.id}> for posting the same message across ${channels.size} channels.`
    ).catch(() => {});
  }
  return true;
}

// --- Slash commands for issuing contracts ----------------------------------
const sellerCmd = new SlashCommandBuilder()
  .setName("seller-agreement")
  .setDescription("Issue an Exclusive Listing (seller's) agreement here")
  .addUserOption((o) => o.setName("seller").setDescription("The seller").setRequired(true))
  .addStringOption((o) => o.setName("plot").setDescription("Plot number / /gps").setRequired(true))
  .addStringOption((o) => o.setName("price").setDescription("Listing price").setRequired(true))
  .addStringOption((o) => o.setName("description").setDescription("Property description").setRequired(false))
  .addStringOption((o) => o.setName("commission").setDescription("Commission (default 10%)").setRequired(false))
  .addIntegerOption((o) => o.setName("term_days").setDescription("Listing term in days (default 30)").setRequired(false));

const purchaseCmd = new SlashCommandBuilder()
  .setName("purchase-agreement")
  .setDescription("Issue a Purchase agreement here")
  .addUserOption((o) => o.setName("buyer").setDescription("The buyer").setRequired(true))
  .addUserOption((o) => o.setName("seller").setDescription("The seller").setRequired(true))
  .addStringOption((o) => o.setName("plot").setDescription("Plot number / /gps").setRequired(true))
  .addStringOption((o) => o.setName("price").setDescription("Purchase price").setRequired(true))
  .addStringOption((o) => o.setName("description").setDescription("Property description").setRequired(false))
  .addStringOption((o) => o.setName("payment_terms").setDescription("Payment terms").setRequired(false))
  .addStringOption((o) => o.setName("special").setDescription("Special requirements").setRequired(false))
  .addStringOption((o) => o.setName("commission").setDescription("Commission (default 10%)").setRequired(false));

const leaseCmd = new SlashCommandBuilder()
  .setName("lease-agreement")
  .setDescription("Issue a lease / rental agreement here")
  .addUserOption((o) => o.setName("landlord").setDescription("The landlord (property owner)").setRequired(true))
  .addUserOption((o) => o.setName("tenant").setDescription("The tenant (renter)").setRequired(true))
  .addStringOption((o) => o.setName("plot").setDescription("Plot number / /gps").setRequired(true))
  .addNumberOption((o) => o.setName("rent").setDescription("Weekly rent — number only (the /week is added automatically)").setRequired(true))
  .addStringOption((o) => o.setName("term").setDescription("Lease term (e.g. 4 weeks; default 4 weeks)").setRequired(false))
  .addStringOption((o) => o.setName("deposit").setDescription("Security deposit").setRequired(false))
  .addStringOption((o) => o.setName("description").setDescription("Property description").setRequired(false))
  .addStringOption((o) => o.setName("commission").setDescription("Commission (default 10%)").setRequired(false))
  .addStringOption((o) => o.setName("special").setDescription("Special requirements").setRequired(false));

const completeDealCmd = new SlashCommandBuilder()
  .setName("complete-deal")
  .setDescription("Legacy escrow retired; retained as safe operator guidance")
  .addIntegerOption((o) => o.setName("contract").setDescription("Contract # to complete").setRequired(true));

const listCmd = new SlashCommandBuilder()
  .setName("list")
  .setDescription("Post a plot listing to the category forum")
  .addStringOption((o) =>
    o.setName("category").setDescription("Listing category").setRequired(true)
      .addChoices(...config.listingCategories.map((c) => ({ name: c, value: c })))
  )
  .addStringOption((o) =>
    o.setName("type").setDescription("Sale or rent").setRequired(true)
      .addChoices({ name: "Sale", value: "Sale" }, { name: "Rent", value: "Rent" })
  )
  .addStringOption((o) => o.setName("plot").setDescription("Plot number / /gps").setRequired(true))
  .addStringOption((o) => o.setName("price").setDescription("Price (e.g. 50000, or 500/week)").setRequired(true))
  .addStringOption((o) => o.setName("title").setDescription("Short listing title").setRequired(true))
  .addStringOption((o) => o.setName("description").setDescription("Details, features, location").setRequired(false))
  .addAttachmentOption((o) => o.setName("image").setDescription("A picture of the plot").setRequired(false));

const contractorAdCmd = new SlashCommandBuilder()
  .setName("contractor-ad")
  .setDescription("Post your company advert to the contractors channel (approved contractors)")
  .addStringOption((o) => o.setName("company").setDescription("Your company name").setRequired(true))
  .addStringOption((o) => o.setName("services").setDescription("Services you offer").setRequired(true))
  .addStringOption((o) => o.setName("contact").setDescription("How to reach you (IGN / Discord)").setRequired(false))
  .addAttachmentOption((o) => o.setName("image").setDescription("A logo or showcase image").setRequired(false));

const panelCmd = new SlashCommandBuilder()
  .setName("panel")
  .setDescription("Open your realtor/manager control panel");

const getPayCmd = new SlashCommandBuilder()
  .setName("pay")
  .setDescription("Legacy contract payment retired; use Treasury finance workflows")
  .addIntegerOption((o) => o.setName("contract").setDescription("Contract # (optional if used in your ticket)").setRequired(false));

const helpCmd = new SlashCommandBuilder()
  .setName("help")
  .setDescription("How to use the Revolution Realty bot");

const setupCmd = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Post the client panel here (admin)");

const resetupCmd = new SlashCommandBuilder()
  .setName("resetup")
  .setDescription("Re-run first-time setup — recreates roles/channels (admin)");

const closeCmd = new SlashCommandBuilder()
  .setName("close")
  .setDescription("Close this ticket");

const contractsCmd = new SlashCommandBuilder()
  .setName("contracts")
  .setDescription("Look up past contracts (staff)")
  .addUserOption((o) => o.setName("user").setDescription("Filter to a party").setRequired(false))
  .addStringOption((o) =>
    o.setName("status").setDescription("Filter by status").setRequired(false)
      .addChoices({ name: "pending", value: "pending" }, { name: "signed", value: "signed" }, { name: "void", value: "void" })
  )
  .addStringOption((o) => o.setName("search").setDescription("Search plot / name / price").setRequired(false));

const contractShowCmd = new SlashCommandBuilder()
  .setName("contract")
  .setDescription("Re-show a contract and re-pull its PDF (staff)")
  .addIntegerOption((o) => o.setName("id").setDescription("Contract #").setRequired(true));

const SLASH_COMMANDS = [
  propertyCommand.toJSON(),
  financeCommand.toJSON(),
  leaseholdCommand.toJSON(),
  sellerCmd.toJSON(),
  purchaseCmd.toJSON(),
  leaseCmd.toJSON(),
  completeDealCmd.toJSON(),
  listCmd.toJSON(),
  contractorAdCmd.toJSON(),
  panelCmd.toJSON(),
  getPayCmd.toJSON(),
  helpCmd.toJSON(),
  setupCmd.toJSON(),
  resetupCmd.toJSON(),
  closeCmd.toJSON(),
  contractsCmd.toJSON(),
  contractShowCmd.toJSON(),
];

async function registerCommands(guild) {
  await guild.commands.set(SLASH_COMMANDS).catch((e) =>
    console.warn(`slash register failed for ${guild.name}:`, e.message)
  );
}

client.once(Events.ClientReady, async (c) => {
  console.log(`🏠 ${config.brandName} online — logged in as ${c.user.tag}`);
  if (!messageContentEnabled) console.warn("Message Content intent disabled; raid guard is inactive on this deployment");
  for (const guild of c.guilds.cache.values()) {
    await pool.query(
      `INSERT INTO guild_config(guild_id,finance_mode,plugin_system) VALUES($1,$2,NULLIF($3,''))
       ON CONFLICT(guild_id) DO UPDATE SET finance_mode=CASE WHEN guild_config.emergency_disabled THEN 'disabled' ELSE excluded.finance_mode END,
       plugin_system=COALESCE(NULLIF(excluded.plugin_system,''),guild_config.plugin_system),updated_at=now()`,
      [guild.id, process.env.FINANCE_MODE || "disabled", process.env.REALTY_PLUGIN_SYSTEM || ""]
    );
    await ensureGuildSetup(guild, c).catch((e) => console.error("setup:", e));
    await registerCommands(guild);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  await ensureGuildSetup(guild, client).catch((e) => console.error("setup:", e));
  await registerCommands(guild);
});

// ===========================================================================
// Buttons
// ===========================================================================
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (await handleFinanceInteraction(i, isManager)) return;
    if (i.isChatInputCommand()) {
      if (i.commandName === "seller-agreement") await issueContract(i, "seller");
      else if (i.commandName === "purchase-agreement") await issueContract(i, "purchase");
      else if (i.commandName === "lease-agreement") await issueContract(i, "lease");
      else if (i.commandName === "complete-deal") await completeDeal(i);
      else if (i.commandName === "list") await handleList(i);
      else if (i.commandName === "contractor-ad") await handleContractorAd(i);
      else if (i.commandName === "panel") await handlePanel(i);
      else if (i.commandName === "pay") await handlePayCommand(i);
      else if (i.commandName === "setup") await handleSetupCmd(i);
      else if (i.commandName === "resetup") await handleResetupCmd(i);
      else if (i.commandName === "close") await handleCloseCmd(i);
      else if (i.commandName === "contracts") await handleContractsCmd(i);
      else if (i.commandName === "contract") await handleContractCmd(i);
      else if (i.commandName === "help") {
        await i.reply({
          embeds: [helpEmbed(isStaff(i.member, i.guild.id), verifyEnabled())],
          ephemeral: true,
        });
      }
      return;
    }
    if (i.isButton()) {
      if (i.customId === "ticket_buy") await openTicket(i, "buy");
      else if (i.customId === "ticket_sell") await openTicket(i, "sell");
      else if (i.customId === "ticket_rent") await openTicket(i, "rent");
      else if (i.customId === "ticket_contractor") await openTicket(i, "contractor");
      else if (i.customId === "find_contractors") await findContractors(i);
      else if (i.customId === "ticket_close") await closeTicketInteraction(i);
      else if (i.customId === "contractor_approve") await reviewContractor(i, true);
      else if (i.customId === "contractor_deny") await reviewContractor(i, false);
      else if (i.customId === "panel_contracts") await panelContracts(i);
      else if (i.customId === "panel_postdesk") await panelPostDesk(i);
      else if (i.customId.startsWith("contract_sign_")) await signContract(i);
      else if (i.customId.startsWith("contract_void_")) await voidContract(i);
      else if (i.customId.startsWith("pay_cmd_")) await handlePayCmd(i);
      else if (i.customId.startsWith("pay_check_")) await handlePayCheck(i);
      else if (i.customId === "verify_start") await startVerification(i);
      else if (i.customId === "verify_check") await checkVerification(i);
    }
  } catch (err) {
    console.error("interaction error:", err);
    // Never leave an interaction hanging on "thinking…" — surface the error.
    const note = `⚠️ Something went wrong: \`${err.message}\``;
    try {
      if (i.deferred || i.replied) await i.editReply(note);
      else if (i.isRepliable?.()) await i.reply({ content: note, ephemeral: true });
    } catch {}
  }
});

// ===========================================================================
// Contracts
// ===========================================================================
const displayName = (member, user) => member?.displayName ?? user.username;
// The IGN a user verified, or a clear fallback if they haven't linked one.
const linkedIgn = (discordId) =>
  store.getVerified(discordId)?.ign ?? "(unverified)";

async function issueContract(i, type) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({
      content: "Only realtors or managers can issue contracts.",
      ephemeral: true,
    });
  }

  const o = i.options;
  const c = config.contract;

  // Which client-side parties each contract type collects (realtor is added
  // automatically as the issuer).
  const partySpec =
    type === "seller"
      ? [{ key: "seller", label: "Seller", opt: "seller" }]
      : type === "lease"
      ? [
          { key: "landlord", label: "Landlord", opt: "landlord" },
          { key: "tenant", label: "Tenant", opt: "tenant" },
        ]
      : [
          { key: "buyer", label: "Buyer", opt: "buyer" },
          { key: "seller", label: "Seller", opt: "seller" },
        ];

  // Resolve + validate the chosen users.
  const chosen = partySpec.map((p) => ({ ...p, user: o.getUser(p.opt) }));
  const botParty = chosen.find((p) => p.user?.bot);
  if (botParty) {
    return i.reply({
      content: `You can't pick a bot (**${botParty.user.username}**) as the ${botParty.label.toLowerCase()} — choose the real player.`,
      ephemeral: true,
    });
  }
  const ids = chosen.map((p) => p.user.id);
  if (new Set(ids).size !== ids.length) {
    return i.reply({
      content: "The same person can't fill two of these roles.",
      ephemeral: true,
    });
  }

  // Acknowledge immediately so the interaction never times out.
  await i.deferReply();

  const realtorName = displayName(i.member, i.user);
  const date = todayISO();

  // Resolve display names for each chosen user.
  for (const p of chosen) {
    const m = await i.guild.members.fetch(p.user.id).catch(() => null);
    p.name = displayName(m, p.user);
  }
  const by = (key) => chosen.find((p) => p.key === key);

  let fields;
  if (type === "seller") {
    const termDays = o.getInteger("term_days") ?? c.termDaysDefault;
    fields = {
      date,
      term_days: termDays,
      expiry_date: plusDaysISO(termDays),
      seller: by("seller").name,
      seller_ign: linkedIgn(by("seller").user.id),
      realtor: realtorName,
      realtor_ign: linkedIgn(i.user.id),
      plot: o.getString("plot"),
      plot_desc: o.getString("description") ?? "—",
      price: o.getString("price"),
      commission: o.getString("commission") ?? c.commissionDefault,
    };
  } else if (type === "lease") {
    fields = {
      date,
      term: o.getString("term") ?? c.leaseTermDefault,
      landlord: by("landlord").name,
      landlord_ign: linkedIgn(by("landlord").user.id),
      tenant: by("tenant").name,
      tenant_ign: linkedIgn(by("tenant").user.id),
      realtor: realtorName,
      realtor_ign: linkedIgn(i.user.id),
      plot: o.getString("plot"),
      plot_desc: o.getString("description") ?? "—",
      rent: o.getNumber("rent"), // weekly rent as a number
      deposit: o.getString("deposit") ?? c.depositDefault,
      commission: o.getString("commission") ?? c.commissionDefault,
      special: o.getString("special") ?? c.specialDefault,
    };
  } else {
    fields = {
      date,
      buyer: by("buyer").name,
      buyer_ign: linkedIgn(by("buyer").user.id),
      seller: by("seller").name,
      seller_ign: linkedIgn(by("seller").user.id),
      realtor: realtorName,
      realtor_ign: linkedIgn(i.user.id),
      plot: o.getString("plot"),
      plot_desc: o.getString("description") ?? "—",
      price: o.getString("price"),
      payment_terms: o.getString("payment_terms") ?? c.paymentTermsDefault,
      special: o.getString("special") ?? c.specialDefault,
      commission: o.getString("commission") ?? c.commissionDefault,
    };
  }

  const parties = [
    ...chosen.map((p) => ({
      key: p.key,
      label: p.label,
      user_id: p.user.id,
      name: p.name,
      signed_at: null,
    })),
    { key: "realtor", label: "Realtor", user_id: i.user.id, name: realtorName, signed_at: null },
  ];

  const contract = store.createContract({
    guild_id: i.guild.id,
    channel_id: i.channel.id,
    type,
    status: "pending",
    created_by: i.user.id,
    created_at: Date.now(),
    fields,
    parties,
  });

  const uniqueIds = [...new Set(parties.map((p) => p.user_id))];
  const pings = uniqueIds.map((id) => `<@${id}>`).join(" ");
  const message = await i.editReply({
    content: `${pings} — please review and **Sign** the agreement below.`,
    embeds: [contractEmbed(contract)],
    components: [contractButtons(contract)],
    allowedMentions: { users: uniqueIds },
  });
  contract.message_id = message.id;
  store.saveContract();
}

async function signContract(i) {
  const id = Number(i.customId.split("_")[2]);
  const contract = store.getContract(id);
  if (!contract || contract.status !== "pending") {
    return i.reply({ content: "This contract isn't open for signing.", ephemeral: true });
  }
  const myParties = contract.parties.filter((p) => p.user_id === i.user.id);
  if (!myParties.length) {
    return i.reply({ content: "You're not a party to this contract.", ephemeral: true });
  }
  const unsigned = myParties.filter((p) => !p.signed_at);
  if (!unsigned.length) {
    return i.reply({ content: "You've already signed this one.", ephemeral: true });
  }

  const now = Date.now();
  unsigned.forEach((p) => (p.signed_at = now)); // sign all roles this person holds
  if (allSigned(contract)) contract.status = "signed";
  store.saveContract();

  await i.update({
    embeds: [contractEmbed(contract)],
    components: [contractButtons(contract)],
  });

  if (contract.status === "signed") {
    const att = await pdfAttachment(contract);
    await i.channel
      .send({ content: `✅ Contract #${contract.id} is fully signed.`, files: [att] })
      .catch(() => {});
    const archiveId = gcfg(i.guild.id, "contractArchiveChannelId");
    if (archiveId) {
      const ch = await client.channels.fetch(archiveId).catch(() => null);
      const att2 = await pdfAttachment(contract);
      ch?.send?.({
        content: `📑 **Contract #${contract.id}** (${contract.type}) — signed, from <#${contract.channel_id}>`,
        files: [att2],
      }).catch(() => {});
    }

    // Set up the buyer/tenant payment panel(s).
    await setupPostSignPayments(contract, i.channel);
  }
}

// Contract/PDF/signature workflows remain available, but the old JSON-backed
// escrow is retired. Financial movement is exclusively handled by the durable
// PostgreSQL Treasury system.
async function setupPostSignPayments() {}

const retiredPaymentReply = (i) => i.reply({
  content: "Legacy contract escrow is retired. Realty rents, refunds and leasehold fees are handled by the Treasury finance commands.",
  ephemeral: true,
});

async function handlePayCmd(i) { return retiredPaymentReply(i); }
async function handlePayCommand(i) { return retiredPaymentReply(i); }
async function handlePayCheck(i) { return retiredPaymentReply(i); }

async function voidContract(i) {
  const id = Number(i.customId.split("_")[2]);
  const contract = store.getContract(id);
  if (!contract || contract.status !== "pending") {
    return i.reply({ content: "This contract can't be voided.", ephemeral: true });
  }
  const isIssuer = contract.created_by === i.user.id;
  if (!isIssuer && !isStaff(i.member, i.guild.id)) {
    return i.reply({
      content: "Only the issuing realtor or a manager can void this.",
      ephemeral: true,
    });
  }
  contract.status = "void";
  store.saveContract();
  await i.update({
    embeds: [contractEmbed(contract)],
    components: [contractButtons(contract)],
  });
}

// Display-only parsing for legacy contract documents. Never use these helpers
// for Treasury money movement.
const parseAmount = (s) => Number(String(s ?? "").replace(/[^0-9.]/g, "")) || 0;
const money = (n) => `$${Number(n).toFixed(2)}`;

async function completeDeal(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "Only realtors or managers can complete deals.", ephemeral: true });
  }
  return i.reply({
    content: "Legacy purchase escrow and automatic seller payouts are retired. Keep the signed contract/PDF as the record and use only the PostgreSQL-backed finance workflows for Treasury transfers.",
    ephemeral: true,
  });
}

// ===========================================================================
// Listings
// ===========================================================================
async function handleList(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "Only realtors or managers can post listings.", ephemeral: true });
  }
  const forums = gcfg(i.guild.id, "listingForums");
  const category = i.options.getString("category");
  const forum = forums?.[category];
  if (!forum) {
    return i.reply({
      content: `No listing channel for **${category}** — run \`/resetup\` to create the listing forums.`,
      ephemeral: true,
    });
  }

  await i.deferReply({ ephemeral: true });

  const type = i.options.getString("type"); // "Sale" | "Rent"
  const att = i.options.getAttachment("image");

  // Re-upload the image so it stays on the post permanently.
  const files = [];
  let imageName = null;
  if (att) {
    try {
      const res = await fetch(att.url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`attachment HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      imageName = (att.name || "listing.png").replace(/[^\w.\-]/g, "_");
      files.push(new AttachmentBuilder(buf, { name: imageName }));
    } catch {
      imageName = null;
    }
  }

  const listing = store.createListing({
    guild_id: i.guild.id,
    category,
    type,
    plot: i.options.getString("plot"),
    price: i.options.getString("price"),
    title: i.options.getString("title"),
    description: i.options.getString("description") ?? "—",
    image_name: imageName,
    realtor: displayName(i.member, i.user),
    realtor_id: i.user.id,
    status: "active",
    created_at: Date.now(),
  });

  const embed = listingEmbed(listing);

  let link;
  try {
    const ch = await client.channels.fetch(forum.channelId);
    if (forum.kind === "forum") {
      const tagId = forum.tags?.[type];
      const thread = await ch.threads.create({
        name: `${listing.title} — ${listing.price}`.slice(0, 95),
        message: { embeds: [embed], files },
        appliedTags: tagId ? [tagId] : [],
      });
      listing.thread_id = thread.id;
      link = `<#${thread.id}>`;
    } else {
      const msg = await ch.send({ embeds: [embed], files });
      listing.message_id = msg.id;
      listing.channel_id = ch.id;
      link = `${ch} (listing posted)`;
    }
    store.saveListings();
  } catch (err) {
    console.error("listing post failed:", err);
    return i.editReply(`Couldn't post the listing: \`${err.message}\``);
  }

  return i.editReply(`✅ Listing **#${listing.id}** posted to ${link}.`);
}

async function openTicket(i, type) {
  const existing = store.getOpenTicketByUser(i.user.id);
  if (existing) {
    const stillThere = await i.guild.channels
      .fetch(existing.channel_id)
      .catch(() => null);
    if (stillThere) {
      return i.reply({
        content: `You already have an open ticket: <#${existing.channel_id}>`,
        ephemeral: true,
      });
    }
    store.closeTicket(existing.channel_id);
  }

  const guild = i.guild;
  const prefix =
    type === "buy"
      ? config.buyTicketPrefix
      : type === "sell"
      ? config.sellTicketPrefix
      : type === "rent"
      ? config.rentTicketPrefix
      : "contractor-";
  const safeName =
    `${prefix}${i.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "")
      .slice(0, 90) || `${prefix}ticket`;

  const realtorRoleId = gcfg(guild.id, "realtorRoleId");
  const managerRoleId = gcfg(guild.id, "managerRoleId");
  const categoryId = gcfg(guild.id, "ticketCategoryId");
  // Contractor applications are handled by managers only (realtors stay out).
  const staffRoleIds =
    type === "contractor"
      ? [managerRoleId].filter(Boolean)
      : [realtorRoleId, managerRoleId].filter(Boolean);

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: i.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    ...staffRoleIds.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })),
  ];

  let channel;
  try {
    channel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: categoryId || null,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    console.error("ticket create failed:", err);
    return i.reply({
      content:
        "Couldn't open a ticket. I need **Manage Channels** and **Manage Roles** permissions" +
        (categoryId ? ", plus access to the Tickets category" : "") +
        `.\n> Discord said: \`${err.message}\``,
      ephemeral: true,
    });
  }

  store.createTicket(channel.id, i.user.id, type, Date.now());

  // Contractor applications ping a manager and show a review (approve/deny) panel.
  const pingRoleId = type === "contractor" ? managerRoleId : realtorRoleId;
  const ping = `<@${i.user.id}>` + (pingRoleId ? ` <@&${pingRoleId}>` : "");
  await channel.send({
    content: ping,
    embeds: [type === "contractor" ? contractorWelcomeEmbed() : ticketWelcomeEmbed(type)],
    components:
      type === "contractor"
        ? [contractorReviewButtons(), closeButton()]
        : [closeButton()],
    allowedMentions: {
      users: [i.user.id],
      roles: pingRoleId ? [pingRoleId] : [],
    },
  });

  return i.reply({
    content: `✅ Your ticket is open: <#${channel.id}>`,
    ephemeral: true,
  });
}

async function closeTicketInteraction(i) {
  if (!store.isTicketChannel(i.channel.id)) {
    return i.reply({ content: "This isn't an open ticket.", ephemeral: true });
  }
  const ticket = store.getTicket(i.channel.id);
  const owner = ticket && ticket.user_id === i.user.id;
  if (!owner && !isStaff(i.member, i.guild.id)) {
    return i.reply({
      content: "Only the client or a realtor/manager can close this ticket.",
      ephemeral: true,
    });
  }
  store.closeTicket(i.channel.id);
  await i.reply({ content: "🔒 Closing this ticket in 5 seconds…", ephemeral: true });
  setTimeout(() => i.channel.delete().catch(() => {}), 5000);
}

// ===========================================================================
// Contractors
// ===========================================================================
async function findContractors(i) {
  const ch = gcfg(i.guild.id, "contractorsChannelId");
  return i.reply({
    content: ch
      ? `🔍 Browse our verified contractors here: <#${ch}>`
      : "No contractors channel is set up yet.",
    ephemeral: true,
  });
}

// ===========================================================================
// Staff control panel (/panel)
// ===========================================================================
async function handlePanel(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "This panel is for realtors and managers.", ephemeral: true });
  }
  const manager = isManager(i.member, i.guild.id);
  return i.reply({
    embeds: [staffPanelEmbed(manager)],
    components: [staffPanelButtons(manager)],
    ephemeral: true,
  });
}

async function panelContracts(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "Staff only.", ephemeral: true });
  }
  const all = store
    .listContracts({ guild_id: i.guild.id })
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 10);
  if (!all.length) return i.reply({ content: "No contracts on file yet.", ephemeral: true });
  await i.deferReply({ ephemeral: true });
  const lines = all.map(contractLine);
  return i.editReply(
    "**Recent contracts:**\n" + lines.join("\n").slice(0, 1800) + "\n\nUse `/contract id:<id>` to re-pull a PDF."
  );
}

async function panelPostDesk(i) {
  if (!isManager(i.member, i.guild.id)) {
    return i.reply({ content: "Only a manager can post the client panel.", ephemeral: true });
  }
  await i.channel.send({ embeds: [panelEmbed()], components: [panelButtons()] }).catch(() => {});
  return i.reply({ content: "✅ Posted the client panel here.", ephemeral: true });
}

async function reviewContractor(i, approve) {
  if (!isManager(i.member, i.guild.id)) {
    return i.reply({ content: "Only a manager can review contractor applications.", ephemeral: true });
  }
  const ticket = store.getTicket(i.channel.id);
  if (!ticket || ticket.type !== "contractor") {
    return i.reply({ content: "This isn't a contractor application.", ephemeral: true });
  }
  const applicantId = ticket.user_id;

  if (approve) {
    const roleId = gcfg(i.guild.id, "contractorRoleId");
    const member = await i.guild.members.fetch(applicantId).catch(() => null);
    if (roleId && member) await member.roles.add(roleId).catch(() => {});
    await i.update({ components: [closeButton()] });
    const adChannel = gcfg(i.guild.id, "contractorsChannelId");
    await i.channel
      .send(
        `✅ <@${applicantId}> has been **approved** as a contractor! ` +
          `You can now advertise your company with \`/contractor-ad\`${adChannel ? ` in <#${adChannel}>` : ""}.`
      )
      .catch(() => {});
  } else {
    await i.update({ components: [closeButton()] });
    await i.channel
      .send(`❌ <@${applicantId}>'s contractor application was **denied**. Reach out if you'd like to reapply with more detail.`)
      .catch(() => {});
  }
}

async function handleContractorAd(i) {
  const roleId = gcfg(i.guild.id, "contractorRoleId");
  const isContractor = roleId && i.member.roles.cache.has(roleId);
  if (!isContractor && !isManager(i.member, i.guild.id)) {
    return i.reply({
      content: "Only approved contractors can post adverts. Use **Become a Contractor** on the Client Desk to apply.",
      ephemeral: true,
    });
  }
  const chId = gcfg(i.guild.id, "contractorsChannelId");
  const ch = chId ? await client.channels.fetch(chId).catch(() => null) : null;
  if (!ch) return i.reply({ content: "No contractors channel is set up.", ephemeral: true });

  await i.deferReply({ ephemeral: true });

  const att = i.options.getAttachment("image");
  const files = [];
  let imageName = null;
  if (att) {
    try {
      const res = await fetch(att.url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`attachment HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      imageName = (att.name || "ad.png").replace(/[^\w.\-]/g, "_");
      files.push(new AttachmentBuilder(buf, { name: imageName }));
    } catch {
      imageName = null;
    }
  }

  const embed = contractorAdEmbed({
    company: i.options.getString("company"),
    services: i.options.getString("services"),
    contact: i.options.getString("contact"),
    image_name: imageName,
    by: displayName(i.member, i.user),
  });
  await ch.send({ embeds: [embed], files }).catch(() => {});
  return i.editReply(`✅ Your advert is posted in <#${ch.id}>.`);
}

// ===========================================================================
// IGN verification
// ===========================================================================
async function startVerification(i) {
  const already = store.getVerified(i.user.id);
  if (already) {
    return i.reply({
      content: `You're already verified as **${already.ign ?? "your account"}**. You can open a ticket in <#${gcfg(i.guild.id, "deskChannelId")}>.`,
      ephemeral: true,
    });
  }
  const code = newMemoCode();
  store.setPendingVerify(i.user.id, code, config.verify.amount);

  const payCmd = config.verify.payCommandTemplate
    .replace("{firm}", config.verify.firmName)
    .replace("{amount}", config.verify.amount)
    .replace("{memo}", code);

  return i.reply({
    content:
      `**Verify your account in 3 steps:**\n` +
      `1. In-game, send **${config.verify.amount}** with this exact memo:\n` +
      "```\n" + payCmd + "\n```" +
      `2. Make sure the memo is **exactly**: \`${code}\`\n` +
      `3. Come back and click **I've sent it** below.`,
    components: [verifyConfirmButton()],
    ephemeral: true,
  });
}

async function checkVerification(i) {
  const pending = store.getPendingVerify(i.user.id);
  if (!pending) {
    return i.reply({
      content: "Start verification first by clicking **Verify my IGN**.",
      ephemeral: true,
    });
  }
  if (!pending.created_at || Date.now() - pending.created_at > 15 * 60 * 1000) {
    store.clearPendingVerify(i.user.id);
    return i.reply({ content: "That verification attempt expired. Start again to receive a new exact payment reference.", ephemeral: true });
  }
  await i.deferReply({ ephemeral: true });

  const result = await findVerificationPayment(
    pending.code,
    config.verify.amount
  );
  if (!result.ok) {
    return i.editReply(
      `Couldn't reach the economy API right now (\`${result.error}\`). Try again in a moment.`
    );
  }
  if (!result.found) {
    return i.editReply(
      "I haven't received your payment yet. Give it a few seconds after sending, then click **I've sent it** again. Double-check the memo matches exactly."
    );
  }
  if (!/^[A-Za-z0-9_]{3,16}$/.test(result.ign || "") || !/^[0-9a-f-]{36}$/i.test(result.uuid || "")) {
    return i.editReply("Treasury confirmed the payment but did not return a verified Minecraft UUID and IGN. Staff have not been given an unsafe placeholder; try again later.");
  }

  const claimedBy = store.ignClaimedBy(result.uuid);
  if (claimedBy && claimedBy !== i.user.id) {
    return i.editReply(
      "That Minecraft account is already verified by another Discord user. Contact staff if this is a mistake."
    );
  }

  await store.setVerified(i.user.id, {
    ign: result.ign,
    uuid: result.uuid,
    txn_id: result.txnId,
  });

  const roleId = gcfg(i.guild.id, "verifiedRoleId");
  if (roleId) await i.member.roles.add(roleId).catch(() => {});

  // Rename the member to their IGN (needs Manage Nicknames + the bot's role
  // above theirs; silently skipped for the owner / higher roles).
  if (config.verify.setNicknameToIgn && result.ign) {
    await i.member.setNickname(result.ign).catch(() => {});
  }

  const desk = gcfg(i.guild.id, "deskChannelId");
  return i.editReply(
    `✅ Verified as **${result.ign ?? "your account"}**! ` +
      (desk ? `You can now open a ticket in <#${desk}>.` : "You can now open a ticket.")
  );
}

// ===========================================================================
// Commands
// ===========================================================================
// Messages are only used for the anti-spam raid guard now — all commands are
// slash commands with private (ephemeral) replies.
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;
    await raidGuard(msg);
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

async function handleSetupCmd(i) {
  if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: "You need the **Manage Server** permission to run this.", ephemeral: true });
  }
  await i.channel.send({ embeds: [panelEmbed()], components: [panelButtons()] });
  return i.reply({ content: "✅ Posted the client panel here.", ephemeral: true });
}

async function handleResetupCmd(i) {
  if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: "You need the **Manage Server** permission to run this.", ephemeral: true });
  }
  await i.deferReply({ ephemeral: true });
  store.setGuildConfig(i.guild.id, { configured: false });
  await ensureGuildSetup(i.guild, client);
  return i.editReply(
    "✅ Setup re-run. New roles/channels were created" +
      (verifyEnabled() ? " (including verification)." : ".") +
      " Old ones aren't deleted — remove any duplicates."
  );
}

async function handleCloseCmd(i) {
  if (!store.isTicketChannel(i.channel.id)) {
    return i.reply({ content: "This isn't an open ticket.", ephemeral: true });
  }
  const ticket = store.getTicket(i.channel.id);
  const owner = ticket && ticket.user_id === i.user.id;
  if (!owner && !isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "Only the client or a realtor/manager can close this ticket.", ephemeral: true });
  }
  store.closeTicket(i.channel.id);
  await i.reply({ content: "🔒 Closing this ticket in 5 seconds…", ephemeral: true });
  setTimeout(() => i.channel.delete().catch(() => {}), 5000);
}

// --- Contract archive / lookup (staff) -------------------------------------
const contractSearchText = (c) =>
  [c.type, c.status, c.fields.plot, c.fields.price, ...c.parties.map((p) => p.name)]
    .join(" ")
    .toLowerCase();

const statusIcon = (s) => (s === "signed" ? "✅" : s === "void" ? "🚫" : "🖊️");

// One-line summary of a contract, with payment progress.
function contractLine(c) {
  const names = c.parties.map((p) => p.name).join(", ");
  let amt;
  if (c.type === "lease") {
    const rent = Number(c.fields.rent) || 0;
    amt = `rent ${money(rent)}/wk · wk ${c.rent_week || 1}: ${money(c.week_paid || 0)}/${money(rent)}`;
  } else if (c.type === "seller") {
    amt = `listed at ${c.fields.price}`;
  } else {
    const price = parseAmount(c.fields.price);
    amt = `paid ${money(c.amount_paid || 0)}/${money(price)}`;
  }
  return `${statusIcon(c.status)} **#${c.id}** ${c.type} — ${names} — plot ${c.fields.plot} · ${amt}`;
}

async function handleContractsCmd(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "Only realtors or managers can look up contracts.", ephemeral: true });
  }
  const all = store
    .listContracts({ guild_id: i.guild.id })
    .sort((a, b) => b.created_at - a.created_at);
  if (!all.length) return i.reply({ content: "No contracts on file yet.", ephemeral: true });

  await i.deferReply({ ephemeral: true });
  const user = i.options.getUser("user");
  const status = i.options.getString("status");
  const search = i.options.getString("search")?.toLowerCase();

  let results = all;
  let label = "Recent contracts";
  if (user) {
    results = all.filter((c) => c.parties.some((p) => p.user_id === user.id));
    label = `Contracts involving ${user.username}`;
  } else if (status) {
    results = all.filter((c) => c.status === status);
    label = `${status[0].toUpperCase()}${status.slice(1)} contracts`;
  } else if (search) {
    results = all.filter((c) => contractSearchText(c).includes(search));
    label = `Contracts matching "${search}"`;
  }
  if (!results.length) return i.editReply("No matching contracts.");

  const shown = results.slice(0, 15);
  const lines = shown.map(contractLine);
  return i.editReply(
    `**${label}** (${results.length} found)\n` +
      lines.join("\n").slice(0, 1800) +
      `\n\nUse \`/contract id:<id>\` to re-pull a contract + PDF.`
  );
}

async function handleContractCmd(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "Only realtors or managers can look up contracts.", ephemeral: true });
  }
  const id = i.options.getInteger("id");
  const c = store.getContract(id);
  if (!c || c.guild_id !== i.guild.id) {
    return i.reply({ content: `No contract #${id} on file.`, ephemeral: true });
  }
  await i.deferReply({ ephemeral: true });
  const files = c.status === "signed" ? [await pdfAttachment(c)] : [];
  return i.editReply({ embeds: [contractEmbed(c)], files });
}

let appServer;
let stopWorker;
let stopSchedulers;
let notificationTimer;
let notificationPromise = null;

async function boot() {
  await store.initLegacyStore();
  const port = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
  appServer = createAppServer();
  await new Promise((resolve, reject) => {
    appServer.once("error", reject);
    appServer.listen(port, resolve);
  });
  console.log(`Health and Treasury HTTPS backend listening internally on :${port}`);
  stopWorker = startWorker();
  stopSchedulers = startSchedulers();
  await client.login(DISCORD_TOKEN);
  await recoverStaleNotifications();
  const notificationTick = () => {
    if (notificationPromise) return;
    notificationPromise = recoverStaleNotifications()
      .then(() => dispatchNotification(client))
      .catch((error) => console.error("notification dispatch", error.message))
      .finally(() => { notificationPromise = null; });
  };
  notificationTick();
  notificationTimer = setInterval(notificationTick, 5000);
  notificationTimer.unref();
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Graceful shutdown requested (${signal})`);
  await stopWorker?.();
  clearInterval(notificationTimer);
  await stopSchedulers?.();
  await notificationPromise;
  client.destroy();
  await store.flushLegacyStore().catch(() => {});
  await new Promise((resolve) => appServer?.close(resolve));
  await shutdownDatabase();
}

process.on("SIGTERM", () => shutdown("SIGTERM").finally(() => process.exit(0)));
process.on("SIGINT", () => shutdown("SIGINT").finally(() => process.exit(0)));

boot().catch((err) => {
  console.error("Startup failed:", err.message);
  process.exit(1);
});
