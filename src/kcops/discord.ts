/**
 * kc-ops access in Discord: /access, /kc owner commands, approval buttons, member-leave and message
 * delivery. Messages are sent with embeds suppressed (link previews would fetch URLs) and no mentions
 * parsed except the people named.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { gate, kcopsEnabled, type OutboxItem } from "./gate.js";

const QUIET = { flags: MessageFlags.SuppressEmbeds as MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] as never[] } };

export const accessCommand = new SlashCommandBuilder()
  .setName("access")
  .setDescription("Get a one-time kc-ops sign-in link (15 minutes; ask for more and Dean decides)")
  .addIntegerOption((o) =>
    o.setName("minutes").setDescription("Session length you need (over 15 needs Dean's approval)").setMinValue(1).setMaxValue(720)
  );

export const kcCommand = new SlashCommandBuilder()
  .setName("kc")
  .setDescription("kc-ops owner commands (Dean only, owner channel)")
  .addSubcommand((s) => s.setName("lockdown").setDescription("End every kc-ops session and refuse new links"))
  .addSubcommand((s) => s.setName("unlock").setDescription("Allow kc-ops access again"))
  .addSubcommand((s) => s.setName("sessions").setDescription("List live kc-ops sessions"))
  .addSubcommand((s) => s.setName("revoke").setDescription("End a person's session").addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true)))
  .addSubcommand((s) => s.setName("approve").setDescription("Approve a person").addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true)))
  .addSubcommand((s) => s.setName("block").setDescription("Block a person").addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true)))
  .addSubcommand((s) => s.setName("relink").setDescription("Let a person link a different Microsoft account").addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true)))
  .addSubcommand((s) =>
    s.setName("expiry").setDescription("Set when a person's access ends (empty = never)")
      .addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true))
      .addIntegerOption((o) => o.setName("days").setDescription("Days from now").setMinValue(1).setMaxValue(3650))
  );

export function kcopsCommands() {
  return kcopsEnabled() ? [accessCommand.toJSON(), kcCommand.toJSON()] : [];
}

/** Button ids: kcops:ext:<requestId>:<minutes|deny>, kcops:person:<discordId>:<approve|block> */
export function extensionButtons(requestId: number, asked: number) {
  const opts = Array.from(new Set([asked, 60, 240].filter((m) => m > 15 && m <= asked))).sort((a, b) => b - a);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...opts.map((m, i) =>
      new ButtonBuilder().setCustomId(`kcops:ext:${requestId}:${m}`).setLabel(`Grant ${fmt(m)}`).setStyle(i === 0 ? ButtonStyle.Success : ButtonStyle.Primary)
    ),
    new ButtonBuilder().setCustomId(`kcops:ext:${requestId}:deny`).setLabel("Deny").setStyle(ButtonStyle.Danger)
  );
}

export function personButtons(discordId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`kcops:person:${discordId}:approve`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`kcops:person:${discordId}:block`).setLabel("Block").setStyle(ButtonStyle.Danger)
  );
}

export function parseButton(id: string):
  | { type: "ext"; requestId: number; minutes: number | null }
  | { type: "person"; discordId: string; action: "approve" | "block" }
  | null {
  const m = /^kcops:ext:(\d{1,18}):(\d{1,4}|deny)$/.exec(id);
  if (m) return { type: "ext", requestId: Number(m[1]), minutes: m[2] === "deny" ? null : Number(m[2]) };
  const p = /^kcops:person:(\d{5,20}):(approve|block)$/.exec(id);
  if (p) return { type: "person", discordId: p[1], action: p[2] as "approve" | "block" };
  return null;
}

export function fmt(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

function linkMessage(url: string, minutes: number): string {
  return `Your kc-ops sign-in link (works once, valid 10 minutes, session ${fmt(minutes)}):\n<${url}>\n` +
    "Open it in your normal browser. Never share it; kc-ops will never ask you for a password here.";
}

async function dmLink(client: Client, userId: string, url: string, minutes: number): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content: linkMessage(url, minutes), ...QUIET });
    return true;
  } catch {
    return false;
  }
}

export async function handleAccess(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const minutes = interaction.options.getInteger("minutes");
  const r = await gate.access({
    discord_id: interaction.user.id,
    channel_id: interaction.channelId,
    is_member: interaction.inGuild() && interaction.guildId === env().DISCORD_GUILD_ID,
    minutes,
  });
  if (r.kind === "refused") {
    await interaction.editReply(r.reason);
    return;
  }
  if (r.kind === "pending_owner") {
    const owner = env().KCOPS_OWNER_CHANNEL_ID;
    const ch = owner ? await interaction.client.channels.fetch(owner) : null;
    if (ch?.isSendable()) {
      await ch.send({
        content: `<@${interaction.user.id}> asks for a ${fmt(r.minutes)} kc-ops session.`,
        components: [extensionButtons(r.request_id, r.minutes)],
        flags: MessageFlags.SuppressEmbeds,
        allowedMentions: { parse: [] },
      });
    }
    await interaction.editReply(`Asked Dean for ${fmt(r.minutes)}. You'll get a DM with the link if he approves (or the standard 15 minutes if not).`);
    return;
  }
  const ok = await dmLink(interaction.client, interaction.user.id, r.url, r.minutes);
  await interaction.editReply(ok ? "Sent you a DM with your sign-in link." : "I couldn't DM you. Allow DMs from server members, then run /access again.");
}

export async function handleKc(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sub = interaction.options.getSubcommand();
  const target = interaction.options.getUser("user")?.id;
  const r = await gate.owner({
    command: sub,
    actor_id: interaction.user.id,
    channel_id: interaction.channelId,
    target_id: target,
    days: sub === "expiry" ? interaction.options.getInteger("days") : undefined,
  });
  await interaction.editReply("ok" in r ? r.text : r.reason);
}

export async function handleKcopsButton(interaction: ButtonInteraction): Promise<void> {
  const b = parseButton(interaction.customId);
  if (!b) return;
  await interaction.deferUpdate();
  if (b.type === "ext") {
    const r = await gate.decision({ request_id: b.requestId, actor_id: interaction.user.id, channel_id: interaction.channelId, minutes: b.minutes });
    if (r.kind === "refused") {
      await interaction.followUp({ content: r.reason, flags: MessageFlags.Ephemeral });
      return;
    }
    if (r.kind === "denied") {
      await dmText(interaction.client, r.discord_id, "Dean declined the extra time. Run /access for a standard 15-minute session.");
      await interaction.editReply({ content: `${interaction.message.content}\nDenied.`, components: [] });
      return;
    }
    const ok = await dmLink(interaction.client, r.discord_id, r.url, r.minutes);
    await interaction.editReply({ content: `${interaction.message.content}\nGranted ${fmt(r.minutes)}${ok ? "" : " (DM failed; ask them to allow DMs and request again)"}.`, components: [] });
    return;
  }
  const r = await gate.owner({ command: b.action, actor_id: interaction.user.id, channel_id: interaction.channelId, target_id: b.discordId });
  if ("ok" in r) {
    await interaction.editReply({ content: `${interaction.message.content}\n${r.text}`, components: [], allowedMentions: { parse: [] } });
  } else {
    await interaction.followUp({ content: r.reason, flags: MessageFlags.Ephemeral });
  }
}

async function dmText(client: Client, userId: string, text: string): Promise<boolean> {
  try {
    await (await client.users.fetch(userId)).send({ content: text, ...QUIET });
    return true;
  } catch {
    return false;
  }
}

/** Deliver queued gate messages, then acknowledge the delivered ones. */
export async function deliverOutbox(client: Client): Promise<number> {
  const { items } = await gate.outbox();
  const done: number[] = [];
  const e = env();
  for (const it of items) {
    try {
      if (it.target === "user" && it.discord_id) {
        if (await dmText(client, it.discord_id, it.text)) done.push(it.id);
        else done.push(it.id); // closed DMs: don't retry forever
        continue;
      }
      const chId = it.target === "owner" ? e.KCOPS_OWNER_CHANNEL_ID : (e.KCOPS_AUDIT_CHANNEL_ID ?? e.KCOPS_OWNER_CHANNEL_ID);
      const ch = chId ? await client.channels.fetch(chId) : null;
      if (!ch?.isSendable()) continue;
      const pid = typeof it.payload?.discord_id === "string" ? it.payload.discord_id : null;
      await ch.send({
        content: it.text,
        components: it.kind === "approve_person" && pid ? [personButtons(pid)] : [],
        flags: MessageFlags.SuppressEmbeds,
        allowedMentions: { parse: [] },
      });
      done.push(it.id);
    } catch (err) {
      logger.warn({ id: it.id, err: String(err) }, "kc-ops outbox delivery failed");
    }
  }
  if (done.length) await gate.ack(done);
  return done.length;
}

export function startKcops(client: Client): void {
  if (!kcopsEnabled()) {
    logger.info("kc-ops access module disabled (KCOPS_GATE_URL/KCOPS_GATE_TOKEN not set)");
    return;
  }
  client.on(Events.GuildMemberRemove, (m: GuildMember | PartialGuildMember) => {
    if (m.guild.id !== env().DISCORD_GUILD_ID) return;
    gate.memberLeft(m.id).catch((err) => logger.error({ err: String(err) }, "kc-ops member-left failed"));
  });
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    deliverOutbox(client)
      .catch((err) => logger.warn({ err: String(err) }, "kc-ops outbox poll failed"))
      .finally(() => (busy = false));
  }, 3000);
  logger.info("kc-ops access module enabled");
}
