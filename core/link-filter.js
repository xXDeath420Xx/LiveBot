/*
 * Default-deny link filtering — the live half of core/link-policy.js.
 *
 * Opt-in per guild and off by default: a server with no self-promo rules should only ever see the
 * commission filter, so nothing here runs until someone turns it on for that specific guild.
 *
 * Two things this deliberately does NOT do:
 *
 *   - Discord invites. events/inviteLinkFilter.js already owns them with its own config and its own
 *     user/role/channel whitelist. Two systems deleting the same message for different reasons,
 *     disagreeing about who is exempt, is worse than either alone.
 *   - Create channels. Most guilds have no log or review channel and are not getting one, so the
 *     queue is written to the database first and posted to Discord only if a channel happens to be
 *     configured. The dashboard is the primary surface.
 *
 * Staff are exempt on the same permissions the commission filter uses, so the two agree on who
 * counts as a moderator.
 */
import { EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { classifyMessage, extractLinks } from './link-policy.js';
import { protectionHold, isIgnoredChannel } from './protection-exempt.js';

const cache = new Map(); // guildId -> { cfg, domains, at }
const TTL = 60_000;

// Handled by the dedicated invite filter — see the header.
const INVITE_HOSTS = new Set(['discord.gg', 'discord.com', 'discordapp.com', 'discord.me', 'invite.gg']);

export function invalidate(guildId) { cache.delete(guildId); }

async function getConfig(guildId) {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < TTL) return hit;
  let cfg = null;
  let domains = { allow: [], deny: [] };
  try {
    const [[row]] = await pool.execute('SELECT * FROM link_policy_config WHERE guild_id = ?', [guildId]);
    cfg = row || null;
    if (cfg) {
      const [rows] = await pool.execute('SELECT domain, kind FROM link_policy_domains WHERE guild_id = ?', [guildId]);
      domains = {
        allow: rows.filter(r => r.kind === 'allow').map(r => r.domain),
        deny: rows.filter(r => r.kind === 'deny').map(r => r.domain),
      };
    }
  } catch { cfg = null; }   // tables absent → feature simply off
  const entry = { cfg, domains, at: Date.now() };
  cache.set(guildId, entry);
  return entry;
}

/** This guild's row plus its domain lists — uncached, for the dashboard and slash command. */
export async function getStats(guildId) {
  try {
    const [[cfg]] = await pool.execute('SELECT * FROM link_policy_config WHERE guild_id = ?', [guildId]);
    const [domains] = await pool.execute(
      'SELECT * FROM link_policy_domains WHERE guild_id = ? ORDER BY kind, domain', [guildId]);
    return { cfg: cfg || null, domains };
  } catch { return { cfg: null, domains: [] }; }
}

function optionsFor(entry) {
  const { cfg, domains } = entry;
  return {
    allow: domains.allow,
    deny: domains.deny,
    unknown: cfg.unknown_action || 'review',
    monetisation: cfg.monetisation_action || 'review',
  };
}

/** Record the verdict first, post to Discord only if a channel exists. */
async function record(message, hit, cfg, { deleted, verdict, links }) {
  const attachments = message.attachments?.size
    ? JSON.stringify([...message.attachments.values()].map(a => ({ name: a.name, url: a.url })))
    : null;

  const [res] = await pool.execute(
    `INSERT INTO link_policy_decisions
       (guild_id, user_id, channel_id, message_id, content, attachments, host, domain, category,
        all_links, verdict, deleted, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [message.guild.id, message.author.id, message.channel.id, message.id,
     (message.content || '').slice(0, 4000), attachments,
     hit.host, hit.domain, hit.category,
     JSON.stringify(links.map(l => ({ h: l.host, c: l.category, v: l.verdict }))),
     verdict, deleted ? 1 : 0, deleted ? 'removed' : 'pending']);
  return res.insertId;
}

async function postCard(message, hit, cfg, { decisionId, deleted }) {
  const channelId = deleted
    ? (cfg.log_channel_id || cfg.review_channel_id)
    : (cfg.review_channel_id || cfg.log_channel_id);
  const ch = channelId && message.guild.channels.cache.get(channelId);
  if (!ch?.isTextBased?.()) return false;

  const embed = new EmbedBuilder()
    .setColor(themeColor(message.guild?.id, deleted ? 'danger' : 'warning'))
    .setTitle(deleted ? '🔗 Blocked link removed' : '🔗 Unrecognised domain — needs a decision')
    .setDescription((message.content || '').slice(0, 1024) || '*(no text)*')
    .addFields(
      { name: 'Domain', value: `\`${hit.domain}\` (${hit.category})`, inline: true },
      { name: 'User', value: `<@${message.author.id}>`, inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
    )
    .setFooter({ text: deleted
      ? `Removal #${decisionId} — wrong? Restore it and the domain is allowed from then on.`
      : `#${decisionId} — message left up. Approving adds ${hit.domain} to the allowlist permanently.` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    deleted
      ? new ButtonBuilder().setCustomId(`linkfp:${decisionId}`).setLabel('Wrong — restore & allow')
          .setEmoji('↩️').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId(`linkok:${decisionId}`).setLabel(`Allow ${hit.domain}`)
          .setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`linkdeny:${decisionId}`).setLabel('Block this domain')
      .setEmoji('🚫').setStyle(ButtonStyle.Danger),
  );

  const sent = await ch.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (sent) {
    await pool.execute(
      `UPDATE link_policy_decisions SET ${deleted ? 'log_message_id' : 'review_message_id'} = ? WHERE id = ?`,
      [sent.id, decisionId]).catch(() => {});
  }
  return !!sent;
}

/**
 * @returns {Promise<boolean>} true when the message was removed and the caller should stop.
 */
export async function checkMessage(message) {
  if (!message.guild || message.author?.bot || !message.member || !message.content) return false;

  const entry = await getConfig(message.guild.id);
  const cfg = entry.cfg;
  if (!cfg || !cfg.enabled) return false;

  const perms = message.member.permissions;
  if (perms.has(PermissionFlagsBits.Administrator)
    || perms.has(PermissionFlagsBits.ModerateMembers)
    || perms.has(PermissionFlagsBits.ManageGuild)
    || perms.has(PermissionFlagsBits.ManageMessages)
    || message.member.id === message.guild.ownerId) return false;

  if (cfg.exempt_channel_ids) {
    try {
      const list = JSON.parse(cfg.exempt_channel_ids);
      if (Array.isArray(list) && list.includes(message.channel.id)) return false;
    } catch { /* malformed = no exemptions */ }
  }

  // Fast path: nothing that looks like a link.
  const found = extractLinks(message.content);
  if (!found.length) return false;

  // Channels and categories on the message protections' ignore list (core/protection-exempt.js).
  if (await isIgnoredChannel(message.channel)) return false;

  const result = classifyMessage(message.content, optionsFor(entry));
  // Invites are someone else's job; drop them before deciding so an invite can never be the
  // reason this filter acts.
  const links = result.links.filter(l => !INVITE_HOSTS.has(l.domain) && !INVITE_HOSTS.has(l.host));
  if (!links.length) return false;

  const rank = { allow: 0, review: 1, block: 2 };
  let worst = links[0];
  for (const l of links) if (rank[l.verdict] > rank[worst.verdict]) worst = l;
  if (worst.verdict === 'allow') return false;

  // A cautious guild can downgrade outright blocks to a review instead.
  const wantsDelete = worst.verdict === 'block' && (cfg.blocked_action || 'delete') === 'delete';

  if (!wantsDelete) {
    const decisionId = await record(message, worst, cfg, { deleted: false, verdict: worst.verdict, links })
      .catch(err => { logger.error(`[LinkFilter] review NOT recorded for ${message.id}: ${err.message}`, { category: 'automod' }); return null; });
    if (decisionId) {
      pool.execute('UPDATE link_policy_config SET review_count = review_count + 1, last_hit_at = NOW() WHERE guild_id = ?',
        [message.guild.id]).catch(() => {});
      await postCard(message, worst, cfg, { decisionId, deleted: false }).catch(() => false);
    }
    logger.info(`[LinkFilter] queued ${worst.domain} (${worst.category}) from ${message.author.id} in ${message.guild.id}#${message.channel.id}`, { category: 'automod' });
    return false;   // message stays up
  }

  // Unified allowlist / global pause: the message stays (core/protection-exempt.js logs the skip).
  if (await protectionHold(message.member, 'delete', 'Link policy')) return false;

  // Capture before deleting — afterwards this is the only copy.
  const decisionId = await record(message, worst, cfg, { deleted: true, verdict: 'block', links })
    .catch(err => { logger.error(`[LinkFilter] removal NOT logged for ${message.id}: ${err.message}`, { category: 'automod' }); return null; });

  const deleted = await message.delete().then(() => true).catch(() => false);
  if (!deleted) {
    if (decisionId) await pool.execute('UPDATE link_policy_decisions SET deleted = 0 WHERE id = ?', [decisionId]).catch(() => {});
    logger.warn(`[LinkFilter] matched ${worst.domain} but could not delete in ${message.channel.id}`, { category: 'automod' });
    return false;
  }

  pool.execute('UPDATE link_policy_config SET deleted_count = deleted_count + 1, last_hit_at = NOW() WHERE guild_id = ?',
    [message.guild.id]).catch(() => {});
  logger.info(`[LinkFilter] removed ${worst.domain} (${worst.category}) from ${message.author.id} in ${message.guild.id}#${message.channel.id}`, { category: 'automod' });

  if (cfg.dm_user) {
    message.author.send(
      `Your message in **${message.guild.name}** was removed automatically — links to \`${worst.domain}\` `
      + 'are not allowed here. If you think that\'s wrong, contact a moderator and they can allow it.').catch(() => {});
  }

  if (decisionId) await postCard(message, worst, cfg, { decisionId, deleted: true }).catch(() => false);
  return true;
}

export default { checkMessage, invalidate, getStats };
