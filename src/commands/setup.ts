import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { logger } from "../util/logger.js";
import { setUserMap, setSetting, deleteSetting } from "../db/index.js";
import { findUserByEmail } from "../services/zammad.js";
import { env } from "../util/env.js";

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
