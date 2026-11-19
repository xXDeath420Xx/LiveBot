import { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import crypto from 'crypto';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';

/*
 * Who sent a confession is kept in confession_senders (migration 431), never in the confession
 * row: members never see it, server admins can reveal it on the dashboard Confessions page (each
 * reveal is written to audit_logs), and data_retention_policy deletes it after 30 days.
 */
export const SENDER_RETENTION_DAYS = 30;
export const PRIVACY_NOTE = `Members can't see who sent it; server admins can for ${SENDER_RETENTION_DAYS} days, to deal with abuse.`;

async function recordSender(confessionId, guildId, userId) {
  await pool.execute(
    'INSERT INTO confession_senders (confession_id, guild_id, user_id) VALUES (?, ?, ?)',
    [confessionId, guildId, userId]
  ).catch(err => logger.warn('[Confessions] Could not record the sender', { confessionId, error: err.message }));
}

/*
 * Per-member cooldown (Confessions page, "Wait between confessions" = confession_config.cooldown_minutes).
 *
 * Kept in memory only, under a keyed hash of server + member made with a secret that exists only
 * for this process, so the cooldown itself never names anyone. A restart clears it.
 */
const COOLDOWN_SECRET = crypto.randomBytes(32);
const lastConfessionAt = new Map(); // hash -> ms

function memberKey(guildId, userId) {
  return crypto.createHmac('sha256', COOLDOWN_SECRET).update(`${guildId}:${userId}`).digest('base64url');
}

export function cooldownMinutes(config) {
  const n = Math.trunc(Number(config?.cooldown_minutes));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1440) : 5;
}

/** When this member may confess again (ms epoch), or 0 if they may now. */
export function confessionAllowedAt(guildId, userId, minutes, now = Date.now()) {
  if (!minutes) return 0;
  const last = lastConfessionAt.get(memberKey(guildId, userId));
  if (!last) return 0;
  const until = last + minutes * 60_000;
  return until > now ? until : 0;
}

export function recordConfession(guildId, userId, now = Date.now()) {
  lastConfessionAt.set(memberKey(guildId, userId), now);
  if (lastConfessionAt.size > 10_000) {
    for (const [k, t] of lastConfessionAt) if (now - t > 86_400_000) lastConfessionAt.delete(k);
  }
}

export function cooldownText(until) {
  const s = Math.ceil(until / 1000);
  return `You can send another confession <t:${s}:R> (at <t:${s}:t>).`;
}

/** The anonymous post a confession becomes (the /confess post and the dashboard's Approve). */
export function confessionEmbed(guildId, number, text) {
  return new EmbedBuilder()
    .setColor(themeColor(guildId, 'primary'))
    .setTitle(`📝 Confession #${number}`)
    .setDescription(String(text || '').slice(0, 4096))
    .setFooter({ text: 'Anonymous' })
    .setTimestamp();
}

export async function handleConfess(interaction) {
  let [[config]] = await pool.execute(
    'SELECT * FROM confession_config WHERE guild_id = ?',
    [interaction.guild.id]
  );

  if (!config || !config.enabled) {
    return interaction.reply({ content: '❌ Confessions are not enabled in this server.', ephemeral: true });
  }

  const waitUntil = confessionAllowedAt(interaction.guild.id, interaction.user.id, cooldownMinutes(config));
  if (waitUntil) {
    return interaction.reply({ content: cooldownText(waitUntil), ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId('confession_modal')
    .setTitle('Confession (anonymous to members)');

  const confessionInput = new TextInputBuilder()
    .setCustomId('confession_text')
    .setLabel('Your Confession')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(`Members won't see who sent this. Server admins can, for ${SENDER_RETENTION_DAYS} days.`)
    .setMinLength(config.min_length || 10)
    .setMaxLength(config.max_length || 1000)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(confessionInput));
  await interaction.showModal(modal);
}

export async function handleConfessModal(interaction) {
  if (interaction.customId !== 'confession_modal') return false;

  // Defer FIRST. Everything below can throw, and an un-deferred interaction has no channel to
  // report the failure on — the catch would itself throw on editReply and the user would just see
  // "This interaction failed" with nothing in the logs to say why.
  await interaction.deferReply({ ephemeral: true });

  const confessionText = interaction.fields.getTextInputValue('confession_text');

  const [[config]] = await pool.execute(
    'SELECT * FROM confession_config WHERE guild_id = ?',
    [interaction.guild.id]
  );

  if (!config || !config.enabled) {
    return interaction.editReply({ content: '❌ Confessions are not enabled.' });
  }

  // Checked again here: two forms opened before either was sent must not both get through.
  const waitUntil = confessionAllowedAt(interaction.guild.id, interaction.user.id, cooldownMinutes(config));
  if (waitUntil) {
    return interaction.editReply({ content: `${cooldownText(waitUntil)} Your text was not sent.` });
  }

  const [[countResult]] = await pool.execute(
    'SELECT COUNT(*) as count FROM confessions WHERE guild_id = ?',
    [interaction.guild.id]
  );

  const confessionNumber = (countResult.count || 0) + 1;

  if (config.require_approval) {
    const [inserted] = await pool.execute(
      `INSERT INTO confessions (guild_id, confession_number, content, channel_id, approved) VALUES (?, ?, ?, ?, FALSE)`,
      [interaction.guild.id, confessionNumber, confessionText, config.channel_id]
    );
    await recordSender(inserted.insertId, interaction.guild.id, interaction.user.id);
    recordConfession(interaction.guild.id, interaction.user.id);
    // Tell staff in the review channel (dashboard "Review channel"); the decision is made on the
    // dashboard, which posts the confession on Approve.
    if (config.mod_channel_id) {
      const review = interaction.guild.channels.cache.get(config.mod_channel_id);
      if (review?.isTextBased?.()) {
        const base = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
        await review.send({ embeds: [new EmbedBuilder()
          .setColor(themeColor(interaction.guildId, 'warning'))
          .setTitle(`Confession #${confessionNumber} is waiting for review`)
          .setURL(`${base}/manage/${interaction.guild.id}?page=confessions`)
          .setDescription(confessionText.slice(0, 4000))
          .setFooter({ text: 'Approve or reject it on the dashboard (Confessions page).' })] }).catch(() => {});
      }
    }
    return interaction.editReply({ content: `✅ Your confession was sent for approval and will be posted if it is approved. ${PRIVACY_NOTE}` });
  } else {
    const channel = interaction.guild.channels.cache.get(config.channel_id)
      || await interaction.guild.channels.fetch(config.channel_id).catch(() => null);
    if (!channel) return interaction.editReply({ content: '❌ Confession channel not found — ask an admin to re-set it.' });

    const embed = confessionEmbed(interaction.guildId, confessionNumber, confessionText);

    const message = await channel.send({ embeds: [embed] });

    const [inserted] = await pool.execute(
      `INSERT INTO confessions (guild_id, confession_number, content, channel_id, message_id, approved) VALUES (?, ?, ?, ?, ?, TRUE)`,
      [interaction.guild.id, confessionNumber, confessionText, config.channel_id, message.id]
    );
    await recordSender(inserted.insertId, interaction.guild.id, interaction.user.id);
    recordConfession(interaction.guild.id, interaction.user.id);

    return interaction.editReply({ content: `✅ Your confession has been posted. ${PRIVACY_NOTE}` });
  }
}
