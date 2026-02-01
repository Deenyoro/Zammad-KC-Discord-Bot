import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { logger } from "../util/logger.js";
import { setUserMap } from "../db/index.js";
import { findUserByEmail } from "../services/zammad.js";

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
  );

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case "usermap":
        return await handleUsermap(interaction);
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
