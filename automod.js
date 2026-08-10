// ---------------------------------------------------------------------------
// automod.js — creates native Discord AutoMod rules (enforced server-side, even
// when the bot is offline): block invite links, mention spam, and spam.
// Requires the bot to have the Manage Server permission.
// ---------------------------------------------------------------------------
import {
  AutoModerationRuleTriggerType,
  AutoModerationRuleEventType,
  AutoModerationActionType,
  PermissionFlagsBits,
} from "discord.js";
import { config } from "./config.js";

const PREFIX = "RR —"; // rule-name prefix so we can detect our own rules

export async function setupAutoMod(guild, logChannelId, exemptRoleIds) {
  if (!config.automod.enabled) return;
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    console.warn("automod: bot lacks Manage Server — skipping AutoMod rules.");
    return;
  }

  let existing;
  try {
    existing = await guild.autoModerationRules.fetch();
  } catch {
    existing = new Map();
  }
  const names = new Set([...existing.values()].map((r) => r.name));
  const exemptRoles = (exemptRoleIds || []).filter(Boolean);
  const alert = logChannelId
    ? [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: logChannelId } }]
    : [];

  const create = async (def) => {
    if (names.has(def.name)) return;
    await guild.autoModerationRules
      .create({ ...def, eventType: AutoModerationRuleEventType.MessageSend, enabled: true, exemptRoles })
      .catch((e) => console.warn(`automod: "${def.name}" failed — ${e.message}`));
  };

  if (config.automod.blockInvites) {
    await create({
      name: `${PREFIX} Block invite links`,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: {
        keywordFilter: [
          "discord.gg/*",
          "discord.com/invite/*",
          "discordapp.com/invite/*",
          "dsc.gg/*",
          "discord.io/*",
        ],
        regexPatterns: [
          "discord(app)?\\.(gg|io)\\/[a-zA-Z0-9-]+",
          "discord(app)?\\.com\\/invite\\/[a-zA-Z0-9-]+",
        ],
      },
      actions: [
        {
          type: AutoModerationActionType.BlockMessage,
          metadata: { customMessage: "Advertising or linking other Discord servers isn't allowed here." },
        },
        ...alert,
      ],
    });
  }

  if (config.automod.mentionLimit) {
    await create({
      name: `${PREFIX} Mention spam`,
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: { mentionTotalLimit: config.automod.mentionLimit },
      actions: [{ type: AutoModerationActionType.BlockMessage }, ...alert],
    });
  }

  if (config.automod.blockSpamPreset) {
    await create({
      name: `${PREFIX} Spam`,
      triggerType: AutoModerationRuleTriggerType.Spam,
      actions: [{ type: AutoModerationActionType.BlockMessage }],
    });
  }
}
