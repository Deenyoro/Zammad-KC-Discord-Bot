import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { logger } from "../util/logger.js";
import { setUserMap, setSetting, deleteSetting, getSetting } from "../db/index.js";
import { findUserByEmail } from "../services/zammad.js";
import { env } from "../util/env.js";
import { getAttachmentLimits } from "../util/attachmentLimits.js";

function isAdmin(userId: string): boolean {
  const ids = env().ADMIN_USER_IDS;
  return ids.length === 0 || ids.includes(userId);
}

export const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Bot setup commands (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sc) =>
    sc
      .setName("usermap")
      .setDescription("Map a Discord user to a Zammad agent")
      .addUserOption((o) =>
        o.setName("discord_user").setDescription("Discord user").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("zammad_email").setDescription("Zammad user email").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("ai")
      .setDescription("Configure AI provider settings")
      .addStringOption((o) =>
        o.setName("api_key").setDescription("AI API key").setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("provider")
          .setDescription("AI provider")
          .setRequired(false)
          .addChoices(
            { name: "OpenRouter (default)", value: "openrouter" },
            { name: "OpenAI", value: "openai" },
            { name: "Anthropic", value: "anthropic" }
          )
      )
      .addStringOption((o) =>
        o.setName("model").setDescription("Model identifier (optional)").setRequired(false)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("search")
      .setDescription("Configure web search provider settings")
      .addStringOption((o) =>
        o.setName("api_key").setDescription("Search API key").setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("provider")
          .setDescription("Search provider")
          .setRequired(false)
          .addChoices(
            { name: "Tavily (default)", value: "tavily" },
            { name: "Brave", value: "brave" }
          )
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("summary")
      .setDescription("Configure daily summary hour (0-23, or 'off' to disable)")
      .addStringOption((o) =>
        o.setName("hour").setDescription("Hour (0-23) or 'off'").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("model")
      .setDescription("Change AI model without re-entering API key")
      .addStringOption((o) =>
        o.setName("model").setDescription("Model identifier").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("language")
      .setDescription("Set default language for AI responses")
      .addStringOption((o) =>
        o
          .setName("lang")
          .setDescription("Default language")
          .setRequired(true)
          .addChoices(
            { name: "English (default)", value: "en" },
            { name: "Portuguese (Brazilian)", value: "pt-br" },
            { name: "Arabic", value: "ar" },
            { name: "Chinese", value: "zh" }
          )
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("timezone")
      .setDescription("Set the bot's default timezone (e.g. America/New_York)")
      .addStringOption((o) =>
        o.setName("tz").setDescription("IANA timezone (e.g. America/New_York, US/Eastern, UTC)").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("keepalive")
      .setDescription("Configure daily keepalive hour (0-23 in bot timezone, or 'off' to disable)")
      .addStringOption((o) =>
        o.setName("hour").setDescription("Hour (0-23) or 'off'").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("weekly-email")
      .setDescription("Set the customer email for Weekly Check tickets")
      .addStringOption((o) =>
        o.setName("email").setDescription("Customer email (e.g. dean@kawaconnect.com)").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("status-refresh")
      .setDescription("Set how often ticket status embeds refresh (minutes, default 60)")
      .addIntegerOption((o) =>
        o.setName("minutes").setDescription("Refresh interval in minutes (default: 60)").setRequired(true).setMinValue(5).setMaxValue(1440)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("checknote")
      .setDescription("Configure the bot and channel for /checknote status snapshots")
      .addStringOption((o) =>
        o.setName("bot_id").setDescription("Discord user ID of the status bot").setRequired(false)
      )
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel where the status board lives").setRequired(false)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("attachments")
      .setDescription("Configure attachment size limits (view current or set new values)")
      .addNumberOption((o) =>
        o.setName("per_file_mb").setDescription("Max MB per file before linking (default: 5)").setRequired(false).setMinValue(1).setMaxValue(25)
      )
      .addNumberOption((o) =>
        o.setName("total_mb").setDescription("Max total MB downloaded per article (default: 24)").setRequired(false).setMinValue(1).setMaxValue(100)
      )
      .addIntegerOption((o) =>
        o.setName("max_count").setDescription("Max files per article (default: 10)").setRequired(false).setMinValue(1).setMaxValue(25)
      )
      .addNumberOption((o) =>
        o.setName("download_cap_mb").setDescription("Hard download cap per file in MB (default: 8)").setRequired(false).setMinValue(1).setMaxValue(50)
      )
  );

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({
      content: "You are not authorised to use setup commands.",
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case "usermap":
        return await handleUsermap(interaction);
      case "ai":
        return await handleAiSetup(interaction);
      case "search":
        return await handleSearchSetup(interaction);
      case "summary":
        return await handleSummarySetup(interaction);
      case "model":
        return await handleModelSetup(interaction);
      case "language":
        return await handleLanguageSetup(interaction);
      case "timezone":
        return await handleTimezoneSetup(interaction);
      case "keepalive":
        return await handleKeepaliveSetup(interaction);
      case "weekly-email":
        return await handleWeeklyEmailSetup(interaction);
      case "attachments":
        return await handleAttachmentsSetup(interaction);
      case "checknote":
        return await handleChecknoteSetup(interaction);
      case "status-refresh":
        return await handleStatusRefreshSetup(interaction);
      default:
        await interaction.reply({ content: "Unknown subcommand.", ephemeral: true });
    }
  } catch (err) {
    logger.error({ sub, err }, "Setup command error");
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`Error: ${msg}`);
    } else {
      await interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
    }
  }
}

async function handleUsermap(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const discordUser = interaction.options.getUser("discord_user", true);
  const zammadEmail = interaction.options.getString("zammad_email", true);

  // Look up the Zammad user to get their ID (works even with broken Elasticsearch)
  const match = await findUserByEmail(zammadEmail);

  setUserMap(discordUser.id, zammadEmail, match?.id);

  const status = match
    ? `Mapped ${discordUser.username} → ${zammadEmail} (Zammad ID: ${match.id}, ${match.firstname} ${match.lastname})`
    : `Mapped ${discordUser.username} → ${zammadEmail} (Zammad user not found by email — mapping saved, but assign won't work until email matches a Zammad user)`;

  await interaction.editReply(status);
  logger.info(
    { discordId: discordUser.id, zammadEmail, zammadId: match?.id },
    "User mapping updated"
  );
}

async function handleAiSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const apiKey = interaction.options.getString("api_key", true);
  const provider = interaction.options.getString("provider") ?? "openrouter";
  const model = interaction.options.getString("model");

  setSetting("AI_API_KEY", apiKey);
  setSetting("AI_PROVIDER", provider);
  if (model) {
    setSetting("AI_MODEL", model);
  }

  await interaction.editReply(
    `AI configured: provider=${provider}${model ? `, model=${model}` : ""}`
  );
  logger.info({ provider, model }, "AI settings updated via /setup ai");
}

async function handleSearchSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const apiKey = interaction.options.getString("api_key", true);
  const provider = interaction.options.getString("provider") ?? "tavily";

  setSetting("SEARCH_API_KEY", apiKey);
  setSetting("SEARCH_PROVIDER", provider);

  await interaction.editReply(`Search configured: provider=${provider}`);
  logger.info({ provider }, "Search settings updated via /setup search");
}

async function handleSummarySetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const hourInput = interaction.options.getString("hour", true);

  if (hourInput.toLowerCase() === "off") {
    deleteSetting("DAILY_SUMMARY_HOUR");
    await interaction.editReply("Daily summary disabled.");
    logger.info("Daily summary disabled via /setup summary");
    return;
  }

  const hour = parseInt(hourInput, 10);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    await interaction.editReply("Invalid hour. Provide a number 0-23 or 'off'.");
    return;
  }

  setSetting("DAILY_SUMMARY_HOUR", String(hour));
  await interaction.editReply(`Daily summary set to ${hour}:00.`);
  logger.info({ hour }, "Daily summary hour updated via /setup summary");
}

async function handleModelSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const model = interaction.options.getString("model", true);

  setSetting("AI_MODEL", model);

  await interaction.editReply(`AI model changed to: ${model}`);
  logger.info({ model }, "AI model updated via /setup model");
}

async function handleLanguageSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const lang = interaction.options.getString("lang", true);
  const langNames: Record<string, string> = {
    en: "English",
    "pt-br": "Brazilian Portuguese",
    ar: "Arabic",
    zh: "Chinese",
  };

  setSetting("AI_DEFAULT_LANGUAGE", lang);

  await interaction.editReply(`Default AI language set to: ${langNames[lang] ?? lang}`);
  logger.info({ lang }, "Default AI language updated via /setup language");
}

async function handleTimezoneSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const tz = interaction.options.getString("tz", true).trim();

  // Validate by trying to use it
  try {
    new Date().toLocaleString("en-US", { timeZone: tz });
  } catch {
    await interaction.editReply(`Invalid timezone: \`${tz}\`. Use an IANA timezone like \`America/New_York\`, \`US/Eastern\`, or \`UTC\`.`);
    return;
  }

  setSetting("TIMEZONE", tz);

  const now = new Date().toLocaleString("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
  await interaction.editReply(`Timezone set to **${tz}**. Current time there: ${now}`);
  logger.info({ tz }, "Timezone updated via /setup timezone");
}

async function handleKeepaliveSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const hourInput = interaction.options.getString("hour", true);

  if (hourInput.toLowerCase() === "off") {
    deleteSetting("KEEPALIVE_HOUR");
    await interaction.editReply("Daily keepalive disabled.");
    logger.info("Daily keepalive disabled via /setup keepalive");
    return;
  }

  const hour = parseInt(hourInput, 10);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    await interaction.editReply("Invalid hour. Provide a number 0-23 or 'off'.");
    return;
  }

  setSetting("KEEPALIVE_HOUR", String(hour));
  await interaction.editReply(`Daily keepalive set to ${hour}:00. Open ticket threads will get a silent status update at this time.`);
  logger.info({ hour }, "Daily keepalive hour updated via /setup keepalive");
}

async function handleAttachmentsSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const perFileMb = interaction.options.getNumber("per_file_mb");
  const totalMb = interaction.options.getNumber("total_mb");
  const maxCount = interaction.options.getInteger("max_count");
  const downloadCapMb = interaction.options.getNumber("download_cap_mb");

  // If no options provided, show current settings
  if (perFileMb === null && totalMb === null && maxCount === null && downloadCapMb === null) {
    const limits = getAttachmentLimits();
    const lines = [
      "**Current Attachment Limits:**",
      `Per-file max: **${limits.perFileMb} MB** (files larger than this are linked, not downloaded)`,
      `Total download max: **${limits.totalMb} MB** per article`,
      `Max file count: **${limits.maxCount}** per article`,
      `Download safety cap: **${limits.downloadCapMb} MB** (hard limit per download)`,
      "",
      "_Use `/setup attachments per_file_mb:10` etc. to change values._",
    ];
    await interaction.editReply(lines.join("\n"));
    return;
  }

  const changes: string[] = [];

  if (perFileMb !== null) {
    setSetting("ATTACHMENT_PER_FILE_MB", String(perFileMb));
    changes.push(`Per-file max: ${perFileMb} MB`);
  }
  if (totalMb !== null) {
    setSetting("ATTACHMENT_TOTAL_MB", String(totalMb));
    changes.push(`Total max: ${totalMb} MB`);
  }
  if (maxCount !== null) {
    setSetting("ATTACHMENT_MAX_COUNT", String(maxCount));
    changes.push(`Max count: ${maxCount}`);
  }
  if (downloadCapMb !== null) {
    setSetting("ATTACHMENT_DOWNLOAD_CAP_MB", String(downloadCapMb));
    changes.push(`Download cap: ${downloadCapMb} MB`);
  }

  await interaction.editReply(`Attachment limits updated:\n${changes.join("\n")}`);
  logger.info({ perFileMb, totalMb, maxCount, downloadCapMb }, "Attachment limits updated via /setup attachments");
}

async function handleWeeklyEmailSetup(interaction: ChatInputCommandInteraction) {
  const email = interaction.options.getString("email", true).trim().toLowerCase();
  if (!email.includes("@")) {
    await interaction.reply({ content: "That doesn't look like a valid email address.", ephemeral: true });
    return;
  }
  setSetting("WEEKLY_CHECK_EMAIL", email);
  await interaction.reply({ content: `Weekly Check ticket customer set to **${email}**.`, ephemeral: true });
  logger.info({ email }, "Weekly check email configured");
}

async function handleChecknoteSetup(interaction: ChatInputCommandInteraction) {
  const botId = interaction.options.getString("bot_id");
  const channel = interaction.options.getChannel("channel");

  if (!botId && !channel) {
    // Show current settings
    const currentBot = getSetting("CHECKNOTE_BOT_ID") ?? "not set";
    const currentChannel = getSetting("CHECKNOTE_CHANNEL_ID") ?? "not set";
    await interaction.reply({
      content: `**Current /checknote config:**\nBot ID: \`${currentBot}\`\nChannel: ${currentChannel !== "not set" ? `<#${currentChannel}>` : "not set"}`,
      ephemeral: true,
    });
    return;
  }

  const changes: string[] = [];

  if (botId) {
    setSetting("CHECKNOTE_BOT_ID", botId.trim());
    changes.push(`Bot ID: \`${botId.trim()}\``);
  }
  if (channel) {
    setSetting("CHECKNOTE_CHANNEL_ID", channel.id);
    changes.push(`Channel: <#${channel.id}>`);
  }

  await interaction.reply({
    content: `Checknote config updated:\n${changes.join("\n")}`,
    ephemeral: true,
  });
  logger.info({ botId, channelId: channel?.id }, "Checknote settings updated");
}

async function handleStatusRefreshSetup(interaction: ChatInputCommandInteraction) {
  const minutes = interaction.options.getInteger("minutes", true);
  setSetting("STATUS_REFRESH_MINUTES", String(minutes));
  await interaction.reply({
    content: `Status embed refresh interval set to **${minutes} minutes**. Restart the bot for the new interval to take effect.`,
    ephemeral: true,
  });
  logger.info({ minutes }, "Status refresh interval updated");
}
