/**
 * kc-ops access in Discord: /access, /kc owner commands, approval buttons, member-leave and message
 * delivery. Messages are sent with embeds suppressed (link previews would fetch URLs) and no mentions
 * parsed except the people named.
 *
 * Who sees what (owner 2026-11-10): the bot never sends a direct message to anyone but the owner. Everything
 * for a staff member (sign-in link, "Is this you?" confirmation, results, notices) is shown in the access
 * channel in a message only they can see: an ephemeral reply or follow-up to their own interaction. When no
 * interaction of theirs is still open (its token lasts 15 minutes), the bot posts a public line with no detail
 * and a button; pressing it shows the content to that person only (the gate checks it is theirs). The owner
 * asks for access by sending the bot a DM and is answered there.
 *
 * Dean is silent (owner 2026-11-11): nothing the owner does is posted in a channel. When he presses a decision
 * button on a prompt in the access channel, the prompt is removed and the result is shown to him alone; his own
 * sign-ins and elevations are never announced (the gate queues no channel notice about him). Staff sign-ins (the
 * start of their day) and staff self-elevations are posted as plain notices.
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
  type Message,
  SlashCommandBuilder,
  escapeMarkdown,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { gate, kcopsEnabled, type ApprovalRoute, type OutboxItem } from "./gate.js";

const QUIET = { flags: MessageFlags.SuppressEmbeds as MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] as never[] } };
/** A reply only the person who started the interaction can see. */
const PRIVATE = { flags: MessageFlags.Ephemeral as MessageFlags.Ephemeral, allowedMentions: { parse: [] as never[] } };

function isOwner(userId: string): boolean {
  return userId === env().KCOPS_OWNER_USER_ID;
}

/**
 * The latest interaction of each staff member in the access channel. Its token allows private follow-ups for
 * 15 minutes; after that (or if Discord refuses) the bot falls back to a public pointer with a button.
 */
type Followable = { followUp: (m: any) => Promise<unknown> };
const live = new Map<string, { interaction: Followable; at: number }>();
export const FOLLOWUP_MS = 14 * 60 * 1000;

export function rememberInteraction(userId: string, interaction: Followable, now = Date.now()): void {
  if (!isOwner(userId)) live.set(userId, { interaction, at: now });
}

export function forgetInteractionsForTests(): void {
  live.clear();
  hinted.clear();
}

export const accessCommand = new SlashCommandBuilder()
  .setName("access")
  .setDescription("Get a one-time kc-ops sign-in link (Dean approves your first sign-in of the day: a 10-hour day)")
  .addIntegerOption((o) =>
    o.setName("minutes").setDescription("Session length (default: your whole day; more than the day needs Dean again; staff max 720)").setMinValue(1).setMaxValue(2880)
  );

export const kcCommand = new SlashCommandBuilder()
  .setName("kc")
  .setDescription("kc-ops owner commands (Dean only; replies only you can see)")
  .addSubcommand((s) => s.setName("lockdown").setDescription("End every kc-ops session and refuse new links"))
  .addSubcommand((s) => s.setName("unlock").setDescription("Allow kc-ops access again"))
  .addSubcommand((s) => s.setName("sessions").setDescription("List live kc-ops sessions"))
  .addSubcommand((s) =>
    s.setName("approval").setDescription("Require your approval for every staff /access request")
      .addStringOption((o) => o.setName("mode").setDescription("on = every request asks you; off = only extra time asks").setRequired(true)
        .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }))
  )
  .addSubcommand((s) =>
    s.setName("notify").setDescription("Where approval requests go")
      .addStringOption((o) => o.setName("where").setDescription("Access channel, your DMs, or both").setRequired(true)
        .addChoices({ name: "Access channel and DMs", value: "both" }, { name: "Access channel only", value: "channel" }, { name: "DMs only", value: "dm" }))
  )
  .addSubcommand((s) =>
    s.setName("default").setDescription("Set the length of a staff day session (default 600 = 10 h)")
      .addIntegerOption((o) => o.setName("minutes").setDescription("Minutes (5-720)").setRequired(true).setMinValue(5).setMaxValue(720))
  )
  .addSubcommand((s) => s.setName("panel").setDescription("Post the Request access button in the access channel"))
  .addSubcommand((s) => s.setName("revoke").setDescription("End a person's session").addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true)))
  .addSubcommand((s) => s.setName("approve").setDescription("Approve a person").addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true)))
  .addSubcommand((s) => s.setName("block").setDescription("Block a person").addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true)))
  .addSubcommand((s) => s.setName("relink").setDescription("Let a person link a different Microsoft account").addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true)))
  .addSubcommandGroup((g) =>
    g.setName("elevation").setDescription("Elevated kc-ops chats")
      .addSubcommand((s) =>
        s.setName("revoke").setDescription("Revoke open elevations (all, or one chat)")
          .addStringOption((o) => o.setName("chat").setDescription("Chat id or prefix (empty = all)").setMinLength(4).setMaxLength(36))
      )
      .addSubcommand((s) => s.setName("list").setDescription("List open elevations"))
  )
  .addSubcommand((s) =>
    s.setName("expiry").setDescription("Set when a person's access ends (empty = never)")
      .addUserOption((o) => o.setName("user").setDescription("Person").setRequired(true))
      .addIntegerOption((o) => o.setName("days").setDescription("Days from now").setMinValue(1).setMaxValue(3650))
  );

export function kcopsCommands() {
  return kcopsEnabled() ? [accessCommand.toJSON(), kcCommand.toJSON()] : [];
}

/**
 * Button ids: kcops:ext:<requestId>:<minutes|deny>, kcops:person:<discordId>:<approve|block>.
 * The first (green) button is the time that was asked for: a first sign-in of the day asks for the whole day
 * (10 h by default), so one click approves the full day. Up to two shorter choices follow.
 */
export function extensionButtons(requestId: number, asked: number) {
  const opts = Array.from(new Set([asked, 240, 120, 60].filter((m) => m > 0 && m <= asked))).sort((a, b) => b - a).slice(0, 3);
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

export function loginButtons(loginId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`kcops:login:${loginId}:yes`).setLabel("It's me").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`kcops:login:${loginId}:no`).setLabel("Not me").setStyle(ButtonStyle.Danger)
  );
}

export function sessionExtensionButtons(extensionId: number, asked: number) {
  const opts = Array.from(new Set([asked, 60].filter((m) => m > 0 && m <= asked))).sort((a, b) => b - a);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...opts.map((m, i) =>
      new ButtonBuilder().setCustomId(`kcops:sext:${extensionId}:${m}`).setLabel(`Grant ${fmt(m)}`).setStyle(i === 0 ? ButtonStyle.Success : ButtonStyle.Primary)
    ),
    new ButtonBuilder().setCustomId(`kcops:sext:${extensionId}:deny`).setLabel("Deny").setStyle(ButtonStyle.Danger)
  );
}

/** Reason text (from the agent or a person) made inert: one line, no backticks, mentions, channel or masked links. */
export function inertReason(reason: unknown): string {
  const t = String(reason ?? "")
    .replace(/[`\r\n\t]+/g, " ")
    .replace(/</g, "‹").replace(/>/g, "›").replace(/\]\(/g, "] (").replace(/@/g, "(at)")
    .replace(/\s+/g, " ").trim();
  return t.slice(0, 300) || "(none)";
}

/** Elevation prompt text: the gate's text with markdown escaped, then the reason as a code block. */
export function elevationText(text: string, reason: unknown): string {
  return `${escapeMarkdown(text)}\nReason:\n\`\`\`text\n${inertReason(reason)}\n\`\`\``;
}

/** Elevation prompt buttons: kcops:elev:<elevationId>:<30|60|120|deny>. Only the owner's press is accepted (gate checks). */
export const ELEVATION_MINUTES = [30, 60, 120] as const;

export function elevationButtons(elevationId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...ELEVATION_MINUTES.map((m, i) =>
      new ButtonBuilder().setCustomId(`kcops:elev:${elevationId}:${m}`).setLabel(`Approve ${fmt(m)}`).setStyle(i === 1 ? ButtonStyle.Success : ButtonStyle.Primary)
    ),
    new ButtonBuilder().setCustomId(`kcops:elev:${elevationId}:deny`).setLabel("Deny").setStyle(ButtonStyle.Danger)
  );
}

/** The public pointer's button: pressing it shows the content to the person it is for, privately. */
export function pointerButton(customId: string, label: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Primary)
  );
}

export const REQUEST_BUTTON = "kcops:request";

export function parseButton(id: string):
  | { type: "request" }
  | { type: "link"; requestId: number }
  | { type: "show"; outboxId: number }
  | { type: "elev"; elevationId: number; minutes: number | null }
  | { type: "login"; loginId: number; answer: "yes" | "no" }
  | { type: "sext"; extensionId: number; minutes: number | null }
  | { type: "ext"; requestId: number; minutes: number | null }
  | { type: "person"; discordId: string; action: "approve" | "block" }
  | null {
  if (id === REQUEST_BUTTON) return { type: "request" };
  const k = /^kcops:link:(\d{1,18})$/.exec(id);
  if (k) return { type: "link", requestId: Number(k[1]) };
  const s = /^kcops:show:(\d{1,18})$/.exec(id);
  if (s) return { type: "show", outboxId: Number(s[1]) };
  const e = /^kcops:elev:(\d{1,18}):(30|60|120|deny)$/.exec(id);
  if (e) return { type: "elev", elevationId: Number(e[1]), minutes: e[2] === "deny" ? null : Number(e[2]) };
  const l = /^kcops:login:(\d{1,18}):(yes|no)$/.exec(id);
  if (l) return { type: "login", loginId: Number(l[1]), answer: l[2] as "yes" | "no" };
  const x = /^kcops:sext:(\d{1,18}):(\d{1,4}|deny)$/.exec(id);
  if (x) return { type: "sext", extensionId: Number(x[1]), minutes: x[2] === "deny" ? null : Number(x[2]) };
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
    "Open it in your normal browser. Only you can see this message; never share the link, and kc-ops will never ask " +
    "you for a password here. After the Microsoft sign-in, come back to Discord and press It's me.";
}

type Shown = { content: string; components?: ActionRowBuilder<ButtonBuilder>[] };
type Pointer = { text: string; label: string; customId: string };

/**
 * Show something to one person and nobody else. The owner gets a DM. Anyone else gets a private follow-up to
 * their latest interaction in the access channel, or, when none is open, a public pointer (no detail) whose
 * button shows the content to them alone. Never a DM to a non-owner.
 */
export async function showPrivately(client: Client, userId: string, msg: Shown, pointer: Pointer): Promise<boolean> {
  if (isOwner(userId)) return dmOwner(client, msg);
  const l = live.get(userId);
  if (l && Date.now() - l.at < FOLLOWUP_MS) {
    try {
      await l.interaction.followUp({ content: msg.content, components: msg.components ?? [], ...PRIVATE });
      return true;
    } catch (err) {
      live.delete(userId); // token expired or revoked: use the pointer
      logger.warn({ err: String(err) }, "kc-ops private follow-up failed");
    }
  }
  const ch = env().KCOPS_ACCESS_CHANNEL_ID;
  if (!ch) return false;
  return postChannel(client, ch, pointer.text, [pointerButton(pointer.customId, pointer.label)], [userId]);
}

/** /access and the Request access button: the answer (link, wait, refusal) is visible to the requester only. */
async function requestAccess(interaction: ChatInputCommandInteraction | ButtonInteraction, minutes: number | null): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
  rememberInteraction(interaction.user.id, interaction);
  if (r.kind === "pending_owner") {
    const asked = await ownerPrompt(interaction.client, {
      content: `<@${interaction.user.id}> asks to start a ${fmt(r.minutes)} kc-ops session (later sign-ins in that time need no approval).`,
      components: [extensionButtons(r.request_id, r.minutes)],
    });
    await interaction.editReply(asked
      ? `Asked Dean to approve ${fmt(r.minutes)} of kc-ops access. When he answers I'll show it here, in a message only you can see. Signing in again within that time needs no new approval.`
      : "Your request is recorded, but I couldn't reach Dean in Discord just now. Message him yourself, or run /access again in a few minutes.");
    return;
  }
  await interaction.editReply({ content: linkMessage(r.url, r.minutes), allowedMentions: { parse: [] } });
}

export async function handleAccess(interaction: ChatInputCommandInteraction): Promise<void> {
  await requestAccess(interaction, interaction.options.getInteger("minutes"));
}

export async function handleKc(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  if (group === "elevation") {
    const r = await gate.owner({
      command: `elevation_${sub}`,
      actor_id: interaction.user.id,
      channel_id: interaction.channelId,
      chat: interaction.options.getString("chat") ?? undefined,
    });
    await interaction.editReply("ok" in r ? r.text : r.reason);
    return;
  }
  if (sub === "panel") {
    // Bot-side only: posts a message with a button. The button does what /access does; the gate decides.
    const ch = env().KCOPS_ACCESS_CHANNEL_ID;
    const ok = isOwner(interaction.user.id) && Boolean(ch) && (await postChannel(interaction.client, ch!,
      "Need kc-ops? Press the button (or run /access). Your sign-in link is shown only to you, never posted here.",
      [pointerButton(REQUEST_BUTTON, "Request access")]));
    await interaction.editReply(ok ? "Posted the Request access button." : isOwner(interaction.user.id)
      ? "Could not post in the access channel (check KCOPS_ACCESS_CHANNEL_ID and my permissions there)." : "Only Dean can do that.");
    return;
  }
  const target = interaction.options.getUser("user")?.id;
  const r = await gate.owner({
    command: sub,
    actor_id: interaction.user.id,
    channel_id: interaction.channelId,
    target_id: target,
    days: sub === "expiry" ? interaction.options.getInteger("days") : undefined,
    minutes: sub === "default" ? interaction.options.getInteger("minutes") : undefined,
    route: sub === "notify" ? interaction.options.getString("where") : sub === "approval" ? interaction.options.getString("mode") : undefined,
  });
  await interaction.editReply("ok" in r ? r.text : r.reason);
}

/**
 * The owner decided on a prompt. In a DM the prompt is edited to show the result (only he sees it). In a channel
 * the result is never shown to others: the prompt (and its buttons) is removed and the result is shown to him in a
 * message only he can see.
 */
async function ownerDecided(interaction: ButtonInteraction, result: string): Promise<void> {
  if (interaction.inGuild()) {
    await interaction.message.delete().catch((err: unknown) => logger.warn({ err: String(err) }, "kc-ops prompt delete failed"));
    await interaction.followUp({ content: `${interaction.message.content}\n${result}`, ...PRIVATE });
    return;
  }
  await interaction.editReply({ content: `${interaction.message.content}\n${result}`, components: [], allowedMentions: { parse: [] } });
}

export async function handleKcopsButton(interaction: ButtonInteraction): Promise<void> {
  const b = parseButton(interaction.customId);
  if (!b) return;
  if (b.type === "request") {
    await requestAccess(interaction, null);
    return;
  }
  if (b.type === "link" || b.type === "show") {
    // A public pointer was pressed: answer privately, and only if the gate says the content is the presser's.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (b.type === "link") {
      const r = await gate.link({ request_id: b.requestId, discord_id: interaction.user.id });
      if (r.kind === "refused") {
        await interaction.editReply(r.reason);
        return;
      }
      rememberInteraction(interaction.user.id, interaction);
      await interaction.editReply({ content: linkMessage(r.url, r.minutes), allowedMentions: { parse: [] } });
      return;
    }
    const r = await gate.notice({ id: b.outboxId, discord_id: interaction.user.id });
    if (r.kind === "refused") {
      await interaction.editReply(r.reason);
      return;
    }
    rememberInteraction(interaction.user.id, interaction);
    const lid = typeof r.payload?.login_id === "number" ? r.payload.login_id : null;
    const confirm = r.item_kind === "login_confirm" && lid !== null;
    await interaction.editReply({ content: r.text, components: confirm ? [loginButtons(lid)] : [], allowedMentions: { parse: [] } });
    if (!confirm) await interaction.message.delete().catch(() => {}); // read: the public pointer has done its job
    return;
  }
  await interaction.deferUpdate();
  if (b.type === "login") rememberInteraction(interaction.user.id, interaction);
  if (b.type === "elev") {
    const r = await gate.elevation({ elevation_id: b.elevationId, actor_id: interaction.user.id, minutes: b.minutes });
    if ("ok" in r) {
      await ownerDecided(interaction, r.text);
    } else {
      // Refused (e.g. not the owner): buttons stay so the owner can still decide.
      await interaction.followUp({ content: r.reason, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (b.type === "login") {
    const r = await gate.loginConfirm({ login_id: b.loginId, actor_id: interaction.user.id, answer: b.answer });
    await interaction.editReply({ content: `${interaction.message.content}\n${"ok" in r ? r.text : r.reason}`, components: [], allowedMentions: { parse: [] } });
    return;
  }
  if (b.type === "sext") {
    const r = await gate.sessionExtension({ extension_id: b.extensionId, actor_id: interaction.user.id, minutes: b.minutes });
    if ("ok" in r) await ownerDecided(interaction, r.text);
    else await interaction.followUp({ content: r.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  if (b.type === "ext") {
    const r = await gate.decision({ request_id: b.requestId, actor_id: interaction.user.id, channel_id: interaction.channelId, minutes: b.minutes });
    if (r.kind === "refused") {
      await interaction.followUp({ content: r.reason, flags: MessageFlags.Ephemeral });
      return;
    }
    if (r.kind === "denied") {
      // The gate queues the "declined" notice for the requester; it is delivered like every other notice.
      await ownerDecided(interaction, "Denied.");
      return;
    }
    const ok = await showPrivately(interaction.client, r.discord_id, { content: linkMessage(r.url, r.minutes) }, {
      text: `<@${r.discord_id}> Dean approved your kc-ops access (${fmt(r.minutes)}). Press the button for your sign-in link; only you will see it.`,
      label: "Show my link",
      customId: `kcops:link:${b.requestId}`,
    });
    await ownerDecided(interaction, `Granted ${fmt(r.minutes)}${ok ? "" : " (I could not tell them; ask them to run /access again)"}.`);
    return;
  }
  const r = await gate.owner({ command: b.action, actor_id: interaction.user.id, channel_id: interaction.channelId, target_id: b.discordId });
  if ("ok" in r) {
    await ownerDecided(interaction, r.text);
  } else {
    await interaction.followUp({ content: r.reason, flags: MessageFlags.Ephemeral });
  }
}

async function dmOwner(client: Client, msg: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] }): Promise<boolean> {
  try {
    const owner = await client.users.fetch(env().KCOPS_OWNER_USER_ID!);
    await owner.send({ content: msg.content, components: msg.components ?? [], ...QUIET });
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, "kc-ops owner DM failed");
    return false;
  }
}

// Last approval route the gate reported (refreshed on every outbox poll).
let approvalRoute: ApprovalRoute = "both";

/** Owner approval prompt: to the access channel and/or the owner's DMs. Buttons only act for the owner (the gate checks). */
async function ownerPrompt(client: Client, msg: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] }): Promise<boolean> {
  const ch = env().KCOPS_ACCESS_CHANNEL_ID;
  const toChannel = Boolean(ch) && approvalRoute !== "dm";
  const toDm = approvalRoute !== "channel" || !ch;
  let ok = false;
  if (toChannel) {
    try {
      const c = await client.channels.fetch(ch!);
      if (c && c.isSendable()) {
        await c.send({ content: msg.content, components: msg.components ?? [], ...QUIET });
        ok = true;
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "kc-ops access channel post failed");
    }
  }
  if (toDm || !ok) ok = (await dmOwner(client, msg)) || ok;
  return ok;
}

async function postChannel(client: Client, channelId: string, text: string, components: ActionRowBuilder<ButtonBuilder>[] = [],
  mention: string[] = []): Promise<boolean> {
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isSendable()) return false;
    // Mentions are shown but never pinged, except the one person a pointer is for.
    await ch.send({ content: text, components, ...QUIET, allowedMentions: mention.length ? { parse: [], users: mention } : { parse: [] } });
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, "kc-ops access channel post failed");
    return false;
  }
}

/** A failed delivery is retried on the next poll until the message is too old to matter (age comes from the gate). */
function giveUp(it: OutboxItem, seconds: number): boolean {
  return typeof it.age !== "number" || it.age > seconds;
}

const APPROVAL_KINDS = new Set(["approve_person", "session_extension", "platform_approval"]);

/** Deliver queued gate messages, then acknowledge the delivered ones. */
export async function deliverOutbox(client: Client): Promise<number> {
  const { items, approval_route } = await gate.outbox();
  if (approval_route) approvalRoute = approval_route;
  const done: number[] = [];
  for (const it of items) {
    try {
      const eid = typeof it.payload?.elevation_id === "number" ? it.payload.elevation_id : null;
      if (it.kind === "elevation" && eid !== null && (it.target === "owner" || it.target === "channel")) {
        // Gate-queued elevation prompt: owner chats by DM, staff chats in the access channel (fallback: owner DM).
        const rows = [elevationButtons(eid)];
        const ch = env().KCOPS_ACCESS_CHANNEL_ID;
        const content = elevationText(it.text, it.payload?.reason);
        let ok = it.target === "channel" && Boolean(ch) && (await postChannel(client, ch!, content, rows));
        if (!ok) ok = await dmOwner(client, { content, components: rows });
        if (ok) done.push(it.id);
        continue;
      }
      if (it.target === "channel") {
        const ch = env().KCOPS_ACCESS_CHANNEL_ID;
        const ok = Boolean(ch) && (await postChannel(client, ch!, it.text));
        if (ok || !ch || giveUp(it, 600)) done.push(it.id); // announcements: retried for 10 minutes
        continue;
      }
      if (it.target === "user") {
        if (!it.discord_id) {
          done.push(it.id);
          continue;
        }
        // For one person: the owner by DM, anyone else privately in the access channel (never a DM).
        const lid = typeof it.payload?.login_id === "number" ? it.payload.login_id : null;
        const confirm = it.kind === "login_confirm" && lid !== null;
        const ok = await showPrivately(client, it.discord_id, { content: it.text, components: confirm ? [loginButtons(lid)] : [] }, {
          text: confirm
            ? `<@${it.discord_id}> confirm your kc-ops sign-in: press the button (only you will see the details).`
            : `<@${it.discord_id}> kc-ops has a message for you. Press the button; only you will see it.`,
          label: "Show details",
          customId: `kcops:show:${it.id}`,
        });
        // The confirmation is only valid for 3 minutes; other notices are retried for 15.
        if (ok || giveUp(it, confirm ? 180 : 900)) done.push(it.id);
        continue;
      }
      const pid = typeof it.payload?.discord_id === "string" ? it.payload.discord_id
        : it.kind === "approve_person" && it.discord_id ? it.discord_id : null; // older gates put it in the column
      const msg = {
        content: it.target === "audit" ? `log: ${it.text}` : it.text,
        components: it.kind === "approve_person" && pid ? [personButtons(pid)]
          : it.kind === "session_extension" && typeof it.payload?.extension_id === "number"
            ? [sessionExtensionButtons(it.payload.extension_id, Number(it.payload.minutes) || 60)] : [],
      };
      // Approval requests follow the owner's route; security alerts and the audit log stay in DMs.
      const isApproval = it.target === "owner" && APPROVAL_KINDS.has(it.kind);
      const ok = isApproval ? await ownerPrompt(client, msg) : await dmOwner(client, msg);
      if (!ok) continue;
      done.push(it.id);
    } catch (err) {
      logger.warn({ id: it.id, err: String(err) }, "kc-ops outbox delivery failed");
    }
  }
  if (done.length) await gate.ack(done);
  return done.length;
}

const ACCESS_WORDS = /\b(access|sign[- ]?in|log[- ]?in|link|kc-?ops)\b/i;
const OWNER_DM = /^\s*\/?access(?:\s+(\d{1,4}))?\s*$/i;
const hinted = new Map<string, number>();
const HINT_MS = 60_000;

/**
 * Plain messages. In the access channel, someone typing a request gets a short public hint to use /access (never
 * a link). In a DM, only the owner is answered: "access" or "access <minutes>" returns his link there, and nothing
 * is posted anywhere else. A DM from anyone else gets no reply (the bot does not DM staff).
 */
export async function handleKcopsMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.guildId) {
    if (!isOwner(message.author.id)) return;
    const m = OWNER_DM.exec(message.content);
    if (!m) {
      if (ACCESS_WORDS.test(message.content)) await message.reply({ content: "Send `access` or `access <minutes>` and I'll reply here with your sign-in link.", ...QUIET });
      return;
    }
    let isMember = false;
    try {
      const guild = await message.client.guilds.fetch(env().DISCORD_GUILD_ID!);
      isMember = Boolean(await guild.members.fetch(message.author.id));
    } catch {
      isMember = false;
    }
    try {
      const r = await gate.access({ discord_id: message.author.id, channel_id: message.channelId, is_member: isMember, minutes: m[1] ? Number(m[1]) : null, owner_dm: true });
      await message.reply({
        content: r.kind === "link" ? linkMessage(r.url, r.minutes) : r.kind === "refused" ? r.reason : "That request needs approval; use /access in the access channel.",
        ...QUIET,
      });
    } catch (err) {
      logger.error({ err: String(err) }, "kc-ops owner DM access failed");
      await message.reply({ content: "kc-ops is not reachable right now. Try again in a minute.", ...QUIET }).catch(() => {});
    }
    return;
  }
  if (message.channelId !== env().KCOPS_ACCESS_CHANNEL_ID || !ACCESS_WORDS.test(message.content)) return;
  const last = hinted.get(message.author.id) ?? 0;
  if (Date.now() - last < HINT_MS) return;
  hinted.set(message.author.id, Date.now());
  await message.reply({
    content: "To get into kc-ops, run `/access` here (or press Request access). I'll show your sign-in link in a message only you can see; links are never posted in this channel.",
    ...QUIET,
  });
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
  client.on(Events.MessageCreate, (m: Message) => {
    handleKcopsMessage(m).catch((err) => logger.warn({ err: String(err) }, "kc-ops message handling failed"));
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
