// ---------------------------------------------------------------------------
// setup.js — first-run provisioning. Creates the roles, ticket category, a
// public client-desk channel with the Buy/Sell panel, and a private contract
// archive, then saves their IDs to the guild config. No manual ID copying.
// ---------------------------------------------------------------------------
import { ChannelType, PermissionFlagsBits } from "discord.js";
import * as store from "./db.js";
import { config } from "./config.js";
import {
  panelEmbed,
  panelButtons,
  verifyPanelEmbed,
  verifyPanelButton,
} from "./embeds.js";
import { verifyEnabled } from "./verify.js";
import { setupAutoMod } from "./automod.js";

const V = PermissionFlagsBits.ViewChannel;
const S = PermissionFlagsBits.SendMessages;
const R = PermissionFlagsBits.ReadMessageHistory;

export async function ensureGuildSetup(guild, client) {
  const existing = store.getGuildConfig(guild.id);
  if (existing.configured) return ensureFinanceChannel(guild, client, existing);

  console.log(`First-time setup for "${guild.name}" (${guild.id})…`);
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    console.warn("setup: couldn't resolve bot member; will retry.");
    return existing;
  }
  const canRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);
  const canChannels = me.permissions.has(PermissionFlagsBits.ManageChannels);

  const cfg = {};

  const gated = verifyEnabled();

  if (canRoles) {
    cfg.managerRoleId = await mk(() =>
      guild.roles.create({
        name: "Manager",
        color: 0x2b6cb0,
        hoist: true,
        reason: "Revolution Realty setup",
      })
    );
    cfg.realtorRoleId = await mk(() =>
      guild.roles.create({
        name: "Realtor",
        color: 0x38a169,
        hoist: true,
        reason: "Revolution Realty setup",
      })
    );
    cfg.contractorRoleId = await mk(() =>
      guild.roles.create({
        name: "Contractor",
        color: 0xdd6b20,
        hoist: true,
        reason: "Revolution Realty setup",
      })
    );
    cfg.collectionsRoleId = await mk(() =>
      guild.roles.create({
        name: "Collections",
        color: 0xc53030,
        mentionable: true,
        reason: "Revolution Realty setup",
      })
    );
    if (gated) {
      cfg.verifiedRoleId = await mk(() =>
        guild.roles.create({
          name: "Verified",
          color: 0x3182ce,
          reason: "Revolution Realty setup",
        })
      );
    }
  }

  if (canChannels) {
    cfg.ticketCategoryId = await mk(() =>
      guild.channels.create({ name: "Tickets", type: ChannelType.GuildCategory })
    );

    const staffView = [
      { id: guild.roles.everyone.id, deny: [V] },
      { id: client.user.id, allow: [V, S, R] },
      ...(cfg.managerRoleId ? [{ id: cfg.managerRoleId, allow: [V, S, R] }] : []),
      ...(cfg.realtorRoleId ? [{ id: cfg.realtorRoleId, allow: [V, S, R] }] : []),
    ];
    const financeView = [
      { id: guild.roles.everyone.id, deny: [V] },
      { id: client.user.id, allow: [V, S, R] },
      ...(cfg.managerRoleId ? [{ id: cfg.managerRoleId, allow: [V, S, R] }] : []),
    ];

    // Private archive for completed contract records.
    cfg.contractArchiveChannelId = await mk(() =>
      guild.channels.create({
        name: "contract-archive",
        type: ChannelType.GuildText,
        permissionOverwrites: staffView,
      })
    );

    // AutoMod alert log (staff-only).
    cfg.automodLogChannelId = await mk(() =>
      guild.channels.create({
        name: "automod-log",
        type: ChannelType.GuildText,
        permissionOverwrites: staffView,
      })
    );

    cfg.financeChannelId = await mk(() =>
      guild.channels.create({
        name: "finance-audit",
        type: ChannelType.GuildText,
        topic: "Private Revolution Realty financial operations and audit alerts",
        permissionOverwrites: financeView,
      })
    );

    // Arrears / payments-due alerts (staff + collections).
    cfg.paymentsDueChannelId = await mk(() =>
      guild.channels.create({
        name: "payments-due",
        type: ChannelType.GuildText,
        permissionOverwrites: [
          ...staffView,
          ...(cfg.collectionsRoleId
            ? [{ id: cfg.collectionsRoleId, allow: [V, S, R] }]
            : []),
        ],
      })
    );

    // Contractors advertising channel: everyone can browse, only the bot/staff
    // post (approved contractors advertise via /contractor-ad).
    cfg.contractorsChannelId = await mk(() =>
      guild.channels.create({
        name: "contractors",
        type: ChannelType.GuildText,
        topic: config.contractor.channelTopic,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [V, R], deny: [S] },
          { id: client.user.id, allow: [V, S, R] },
          ...(cfg.managerRoleId ? [{ id: cfg.managerRoleId, allow: [V, S, R] }] : []),
        ],
      })
    );

    // Verification channel (only when verification is enabled). Visible to all
    // so unverified users can verify; they only need to click a button.
    if (gated) {
      const verifyId = await mk(() =>
        guild.channels.create({
          name: "verify-here",
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: [V, R],
              deny: [S], // read + click only
            },
            { id: client.user.id, allow: [V, S, R] },
          ],
        })
      );
      if (verifyId) {
        const ch = await guild.channels.fetch(verifyId).catch(() => null);
        if (ch)
          await ch
            .send({ embeds: [verifyPanelEmbed()], components: [verifyPanelButton()] })
            .catch(() => {});
        cfg.verifyChannelId = verifyId;
      }
    }

    // Client desk with the Buy/Sell panel. Locked to Verified + staff when
    // verification is enabled; public otherwise.
    const deskOverwrites = gated
      ? [
          { id: guild.roles.everyone.id, deny: [V] },
          { id: client.user.id, allow: [V, S, R] },
          ...(cfg.verifiedRoleId ? [{ id: cfg.verifiedRoleId, allow: [V, S, R] }] : []),
          ...(cfg.managerRoleId ? [{ id: cfg.managerRoleId, allow: [V, S, R] }] : []),
          ...(cfg.realtorRoleId ? [{ id: cfg.realtorRoleId, allow: [V, S, R] }] : []),
        ]
      : undefined;
    const deskId = await mk(() =>
      guild.channels.create({
        name: "client-desk",
        type: ChannelType.GuildText,
        ...(deskOverwrites ? { permissionOverwrites: deskOverwrites } : {}),
      })
    );
    if (deskId) {
      const ch = await guild.channels.fetch(deskId).catch(() => null);
      if (ch)
        await ch
          .send({ embeds: [panelEmbed()], components: [panelButtons()] })
          .catch(() => {});
      cfg.deskChannelId = deskId;
    }

    // Listings: a category with a forum channel per listing category.
    const listCatId = await mk(() =>
      guild.channels.create({ name: "Listings", type: ChannelType.GuildCategory })
    );
    cfg.listingsCategoryId = listCatId;
    cfg.listingForums = {};

    // Members can browse + comment, but only the bot/staff can create listings.
    const P = PermissionFlagsBits;
    const listingOverwrites = [
      {
        id: guild.roles.everyone.id,
        allow: [V, R, P.SendMessagesInThreads],
        deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads],
      },
      { id: client.user.id, allow: [V, R, S, P.CreatePublicThreads, P.SendMessagesInThreads, P.ManageThreads] },
      ...(cfg.managerRoleId ? [{ id: cfg.managerRoleId, allow: [V, R, S, P.CreatePublicThreads, P.SendMessagesInThreads, P.ManageThreads] }] : []),
      ...(cfg.realtorRoleId ? [{ id: cfg.realtorRoleId, allow: [V, R, S, P.CreatePublicThreads, P.SendMessagesInThreads] }] : []),
    ];

    for (const cat of config.listingCategories) {
      let channelId = null;
      let kind = "forum";
      const tags = {};
      try {
        const f = await guild.channels.create({
          name: cat.toLowerCase(),
          type: ChannelType.GuildForum,
          parent: listCatId || null,
          topic: `${cat} plot listings — posted by Revolution Realty`,
          availableTags: config.listingTags.map((t) => ({ name: t })),
          permissionOverwrites: listingOverwrites,
        });
        channelId = f.id;
        for (const t of f.availableTags) tags[t.name] = t.id;
      } catch (err) {
        // Forum channels may be unavailable; fall back to a text channel.
        console.warn(`setup: forum for ${cat} failed (${err.message}); using text.`);
        channelId = await mk(() =>
          guild.channels.create({
            name: cat.toLowerCase(),
            type: ChannelType.GuildText,
            parent: listCatId || null,
            topic: `${cat} plot listings`,
            permissionOverwrites: listingOverwrites,
          })
        );
        kind = "text";
      }
      if (channelId) cfg.listingForums[cat] = { channelId, kind, tags };
    }
  }

  // Native AutoMod rules (invite/spam/mention), exempting staff roles.
  await setupAutoMod(
    guild,
    cfg.automodLogChannelId,
    [cfg.managerRoleId, cfg.realtorRoleId, cfg.contractorRoleId]
  ).catch((e) => console.warn("automod setup:", e.message));

  cfg.configured = true;
  cfg.setupAt = Date.now();
  store.setGuildConfig(guild.id, cfg);

  await notifyOwner(guild, cfg).catch(() => {});
  console.log(`Setup complete for "${guild.name}".`);
  return store.getGuildConfig(guild.id);
}

export async function ensureFinanceChannel(guild, client, existing = store.getGuildConfig(guild.id)) {
  if (existing.financeChannelId) {
    const channel = await guild.channels.fetch(existing.financeChannelId).catch(() => null);
    if (channel) {
      await hardenFinanceChannel(channel, guild, client, existing).catch((error) => console.warn("finance channel permissions:", error.message));
      await syncFinanceChannel(guild.id, existing.financeChannelId);
      return existing;
    }
  }
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) return existing;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [V] },
    { id: client.user.id, allow: [V, S, R] },
    ...(existing.managerRoleId ? [{ id: existing.managerRoleId, allow: [V, S, R] }] : []),
  ];
  const financeChannelId = await mk(() => guild.channels.create({
    name: "finance-audit",
    type: ChannelType.GuildText,
    topic: "Private Revolution Realty financial operations and audit alerts",
    permissionOverwrites: overwrites,
  }));
  if (!financeChannelId) return existing;
  const updated = store.setGuildConfig(guild.id, { financeChannelId });
  const channel = await guild.channels.fetch(financeChannelId).catch(() => null);
  if (channel) await hardenFinanceChannel(channel, guild, client, existing).catch(() => {});
  await syncFinanceChannel(guild.id, financeChannelId);
  return updated;
}

async function hardenFinanceChannel(channel, guild, client, configState) {
  await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false });
  await channel.permissionOverwrites.edit(client.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
  if (configState.managerRoleId) await channel.permissionOverwrites.edit(configState.managerRoleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
  if (configState.realtorRoleId) await channel.permissionOverwrites.delete(configState.realtorRoleId).catch(() => {});
}

async function syncFinanceChannel(guildId, financeChannelId) {
  await import("./src/database.js").then(({ pool }) => pool.query(
    `INSERT INTO guild_config(guild_id,finance_channel_id) VALUES($1,$2)
     ON CONFLICT(guild_id) DO UPDATE SET finance_channel_id=excluded.finance_channel_id,updated_at=now()`,
    [guildId, financeChannelId]
  ));
}

async function mk(fn) {
  try {
    const obj = await fn();
    return obj.id;
  } catch (err) {
    console.warn("setup: skipped a resource —", err.message);
    return null;
  }
}

async function notifyOwner(guild, cfg) {
  const owner = await guild.fetchOwner().catch(() => null);
  if (!owner) return;
  const line = (label, id, type) =>
    id
      ? `• ${label}: ${type === "ch" ? `<#${id}>` : `<@&${id}>`}`
      : `• ${label}: ⚠️ not created (missing permission)`;
  const { EmbedBuilder } = await import("discord.js");
  const embed = new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(`✅ ${config.brandName} is set up in ${guild.name}`)
    .setDescription(
      [
        "Created the essentials:",
        line("Manager role", cfg.managerRoleId),
        line("Realtor role", cfg.realtorRoleId),
        line("Contractor role", cfg.contractorRoleId),
        line("Collections role", cfg.collectionsRoleId),
        ...(cfg.verifiedRoleId ? [line("Verified role", cfg.verifiedRoleId)] : []),
        line("Client desk (panel)", cfg.deskChannelId, "ch"),
        ...(cfg.verifyChannelId ? [line("Verify channel", cfg.verifyChannelId, "ch")] : []),
        line("Contractors", cfg.contractorsChannelId, "ch"),
        line("Contract archive", cfg.contractArchiveChannelId, "ch"),
        line("Payments due", cfg.paymentsDueChannelId, "ch"),
        line("AutoMod log", cfg.automodLogChannelId, "ch"),
        `• Listing forums: ${
          Object.keys(cfg.listingForums || {}).length
            ? Object.values(cfg.listingForums)
                .map((f) => `<#${f.channelId}>`)
                .join(" ")
            : "⚠️ not created"
        }`,
        "",
        cfg.verifyChannelId
          ? "**Verification is ON** — clients must verify their IGN before the Client Desk unlocks."
          : "Verification is off (set `DC_API_TOKEN` + `VERIFY_ACCOUNT_ID`, then `/resetup`, to require IGN verification).",
        "**Next:** assign the Realtor/Manager roles to your staff. Run `/help` for commands.",
      ].join("\n")
    );
  await owner.send({ embeds: [embed] });
}
