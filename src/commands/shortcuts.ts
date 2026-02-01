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

export const ownerCommand = new SlashCommandBuilder()
  .setName("owner")
  .setDescription("Set ticket owner (defaults to yourself)")
  .addUserOption((o) =>
    o.setName("user").setDescription("Discord user to assign (leave empty for yourself)").setRequired(false)
  );
