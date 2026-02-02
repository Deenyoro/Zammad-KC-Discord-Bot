import { SlashCommandBuilder } from "discord.js";

export const replyCommand = new SlashCommandBuilder()
  .setName("reply")
  .setDescription("Send a reply to the customer (email/SMS/Teams)")
  .addStringOption((o) =>
    o.setName("text").setDescription("Reply text").setRequired(true)
  )
  .addAttachmentOption((o) =>
    o.setName("file").setDescription("Attach a file (image, document, etc.)").setRequired(false)
  );

export const noteCommand = new SlashCommandBuilder()
  .setName("note")
  .setDescription("Add an internal note to the ticket")
  .addStringOption((o) =>
    o.setName("text").setDescription("Note text").setRequired(true)
  )
  .addAttachmentOption((o) =>
    o.setName("file").setDescription("Attach a file (image, document, etc.)").setRequired(false)
  );

export const pendingCommand = new SlashCommandBuilder()
  .setName("pending")
  .setDescription("Set ticket to a pending state with a duration")
  .addStringOption((o) =>
    o
      .setName("type")
      .setDescription("Pending type")
      .setRequired(true)
      .addChoices(
        { name: "pending reminder", value: "pending reminder" },
        { name: "pending close", value: "pending close" }
      )
  )
  .addStringOption((o) =>
    o
      .setName("duration")
      .setDescription("How long until the pending time expires")
      .setRequired(true)
      .addChoices(
        { name: "1 day", value: "1d" },
        { name: "3 days", value: "3d" },
        { name: "1 week", value: "1w" },
        { name: "2 weeks", value: "2w" },
        { name: "1 month", value: "1m" },
        { name: "3 months", value: "3m" }
      )
  );

export const ownerCommand = new SlashCommandBuilder()
  .setName("owner")
  .setDescription("Set ticket owner (defaults to yourself)")
  .addUserOption((o) =>
    o.setName("user").setDescription("Discord user to assign (leave empty for yourself)").setRequired(false)
  );
