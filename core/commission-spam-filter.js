/*
 * Commission / paid-work advertising filter.
 *
 * GFX-artist, VTuber-rig and artwork "commissions open" spam turns up in servers whose rules forbid
 * self-promotion, usually from drive-by accounts. This deletes those messages automatically.
 *
 * EXEMPTIONS: administrators and moderators are never touched. "Moderator" = the `ModerateMembers`
 * permission, matching how the phishing / raid / spam managers already define staff in this codebase,
 * so a mod posting "commissions open for the charity stream" is fine while a random member is not.
 *
 * Config-driven (commission_spam_config) so phrases, channel scope, DM-on-delete and the log channel
 * are all tunable per guild via /moderation commission-filter — no code change to adjust what it catches. By
 * default it runs in EVERY channel with a sensible built-in phrase list.
 *
 * The matching itself lives in ./commission-spam-match.js, with no DB import, so the retroactive
 * backfill script and the unit tests can share this module's exact decision rather than
 * reimplementing it and drifting.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { protectionHold } from './protection-exempt.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  PHRASE_GROUPS, DEFAULT_PHRASES, PATTERN_RULES, SOFT_SELL_SIGNALS,
  SOFT_SELL_DELETE_AT, SOFT_SELL_REVIEW_AT,
  normalise, hasCommerceSignal, matchCommissionAd, scoreSoftSell, evaluateCommissionAd,
} from './commission-spam-match.js';

export {
  PHRASE_GROUPS, DEFAULT_PHRASES, PATTERN_RULES, SOFT_SELL_SIGNALS,
  normalise, hasCommerceSignal, matchCommissionAd, scoreSoftSell, evaluateCommissionAd,
};

const cache = new Map(); // guildId -> { cfg, at }
const TTL = 60_000;

async function getConfig(guildId) {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < TTL) return hit.cfg;
  let cfg = null;
  try {
    const [[row]] = await pool.execute('SELECT * FROM commission_spam_config WHERE guild_id = ?', [guildId]);
    cfg = row || null;
  } catch { cfg = null; } // table absent → feature simply off
  cache.set(guildId, { cfg, at: Date.now() });
  return cfg;
}

export function invalidate(guildId) { cache.delete(guildId); }

/** This guild's row (enabled, removal count, custom phrases, etc.), or null. Uncached — for UI reads. */
export async function getStats(guildId) {
  try {
    const [[row]] = await pool.execute('SELECT * FROM commission_spam_config WHERE guild_id = ?', [guildId]);
    return row || null;
  } catch { return null; }
}

/** Network-wide totals for the dashboard header. */
export async function getGlobalStats() {
  try {
    const [[r]] = await pool.execute(
      'SELECT COUNT(*) AS enabledCount, COALESCE(SUM(deleted_count),0) AS totalRemoved FROM commission_spam_config WHERE enabled = 1');
    return { enabledCount: Number(r.enabledCount), totalRemoved: Number(r.totalRemoved) };
  } catch { return { enabledCount: 0, totalRemoved: 0 }; }
}

/** The phrase groups actually in force for a guild — custom overrides fall back to the defaults. */
export function groupsFor(cfg) {
  const custom = customPhrasesOf(cfg);
  if (custom) {
    return [{ key: 'custom', icon: '✳️', title: 'Custom list for this server', desc: 'This server replaced the defaults with its own phrases.', phrases: custom }];
  }
  return PHRASE_GROUPS;
}

/** A guild's own phrase list, or null when it is running the defaults. */
function customPhrasesOf(cfg) {
  if (!cfg?.phrases) return null;
  try {
    const arr = JSON.parse(cfg.phrases);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch { return null; }
}

/**
 * The matcher options implied by a guild's config. A guild that supplied its own phrases opts out
 * of the built-in regex rules too — "replace the defaults" means all of them.
 */
export function matchOptionsFor(cfg) {
  const custom = customPhrasesOf(cfg);
  return custom ? { phrases: custom, usePatterns: false } : { phrases: DEFAULT_PHRASES, usePatterns: true };
}

/**
 * How much this guild's own moderation history lowers the bar for a given poster.
 *
 * The signals themselves are fixed; what adapts is how much corroboration a particular person needs
 * before the filter acts. Someone a moderator has already confirmed as an advertiser here does not
 * get the benefit of the doubt a second time, so their next borderline post is judged more harshly.
 * Capped, because history should tilt a marginal call, never manufacture one on its own — and only
 * confirmations count, so a wrongly-flagged member who was cleared is not penalised for it.
 */
export async function adaptiveBoostFor(guildId, userId) {
  try {
    const [[row]] = await pool.execute(
      `SELECT COUNT(*) AS n FROM commission_spam_decisions
       WHERE guild_id = ? AND user_id = ? AND verdict = 'confirmed'`,
      [guildId, userId]);
    return Math.min(Number(row?.n) || 0, 3);
  } catch { return 0; }
}

/** Everything the matcher needs for this guild + poster, thresholds and adaptation included. */
async function evaluateOptionsFor(cfg, guildId, userId) {
  const base = matchOptionsFor(cfg);
  return {
    ...base,
    softSell: base.usePatterns && !!cfg.soft_sell_enabled,
    deleteAt: cfg.soft_sell_delete_at ?? SOFT_SELL_DELETE_AT,
    reviewAt: cfg.soft_sell_review_at ?? SOFT_SELL_REVIEW_AT,
    scoreBoost: cfg.soft_sell_enabled ? await adaptiveBoostFor(guildId, userId) : 0,
  };
}

/**
 * Stable key for "this exact message, again". Built on normalise() so the same post survives a
 * different emoji, capitalisation or stray punctuation and still matches its exemption.
 */
export function contentKey(content) {
  const t = normalise(content);
  if (!t) return null;
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}:${t.length}`;
}

/**
 * The guild's "you got this one wrong" list, built by moderators ruling on false positives.
 * Checked BEFORE any deletion, so a message a moderator has already cleared can never be removed
 * again — which is the whole point of the undo being durable rather than a one-off restore.
 */
export async function exemptionFor(guildId, message, hit) {
  try {
    const [rows] = await pool.execute(
      'SELECT kind, value FROM commission_spam_exemptions WHERE guild_id = ?', [guildId]);
    if (!rows.length) return null;

    const key = contentKey(message.content);
    const triggers = triggerKeysOf(hit);
    for (const r of rows) {
      if (r.kind === 'user' && r.value === message.author.id) return r;
      if (r.kind === 'content' && key && r.value === key) return r;
      if (r.kind === 'trigger' && triggers.includes(r.value)) return r;
    }
    return null;
  } catch { return null; }
}

/**
 * What a moderator would be switching off if they said "stop matching this here" — the phrase, the
 * pattern rule, or the soft-sell signal combination that actually fired.
 */
export function triggerKeysOf(hit) {
  if (!hit) return [];
  if (hit.via === 'phrase') return [`phrase:${hit.matched}`];
  if (hit.via === 'pattern') return [`pattern:${hit.rule}`];
  if (hit.via === 'soft-sell') return [`soft:${(hit.signals || []).slice().sort().join('+')}`];
  return [];
}

/** Post a borderline soft-sell hit for a moderator to rule on. The message is left in place. */
async function queueForReview(message, verdict, cfg) {
  // The row is written FIRST and unconditionally. Most guilds have no log channel — and are not
  // going to be given one — so the dashboard review queue is the primary surface, not a fallback.
  // Returning early when there is no channel used to drop the verdict on the floor entirely.
  const [res] = await pool.execute(
    `INSERT INTO commission_spam_decisions
       (guild_id, user_id, channel_id, message_id, content, score, signals, verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [message.guild.id, message.author.id, message.channel.id, message.id,
     (message.content || '').slice(0, 4000), verdict.score, verdict.signals.join(',')]);
  const decisionId = res.insertId;

  pool.execute('UPDATE commission_spam_config SET soft_sell_review_count = soft_sell_review_count + 1 WHERE guild_id = ?',
    [message.guild.id]).catch(() => {});

  // Only NOW does the Discord side matter. No channel configured is a normal, supported state —
  // the queue lives in the dashboard and we do not go creating log channels to compensate.
  const channelId = cfg.review_channel_id || cfg.log_channel_id;
  const ch = channelId && message.guild.channels.cache.get(channelId);
  if (!ch?.isTextBased?.()) return { queued: true, posted: false };

  const embed = new EmbedBuilder()
    .setColor(themeColor(message.guild?.id, 'warning'))
    .setTitle('🔎 Possible commission ad — needs a decision')
    .setDescription((message.content || '').slice(0, 1024))
    .addFields(
      { name: 'User', value: `<@${message.author.id}> (${message.author.id})`, inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Score', value: `${verdict.score} (deletes at ${cfg.soft_sell_delete_at ?? SOFT_SELL_DELETE_AT})`, inline: true },
      { name: 'Signals', value: verdict.signals.map(s => `\`${s}\``).join(' ') || '—', inline: false },
      { name: 'Message', value: `[jump](${message.url})`, inline: false },
    )
    .setFooter({ text: 'Not deleted — this one was too close to call automatically.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`commrev_del:${decisionId}`).setLabel('Delete it').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`commrev_ok:${decisionId}`).setLabel('Allow it').setEmoji('✅').setStyle(ButtonStyle.Secondary),
  );

  const sent = await ch.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (sent) {
    await pool.execute('UPDATE commission_spam_decisions SET review_message_id = ? WHERE id = ?',
      [sent.id, decisionId]).catch(() => {});
  }
  return { queued: true, posted: !!sent };
}

/**
 * @returns {Promise<boolean>} true when the message was a commission ad and was deleted (caller
 * should stop processing it), false otherwise.
 */
export async function checkMessage(message) {
  if (!message.guild || message.author?.bot || !message.member || !message.content) return false;

  const cfg = await getConfig(message.guild.id);
  if (!cfg || !cfg.enabled) return false;

  // Never touch staff.
  const perms = message.member.permissions;
  if (perms.has(PermissionFlagsBits.Administrator)
    || perms.has(PermissionFlagsBits.ModerateMembers)
    || perms.has(PermissionFlagsBits.ManageGuild)
    || message.member.id === message.guild.ownerId) return false;

  // Optional channel scope. Empty / null = every channel.
  if (cfg.channel_ids) {
    try {
      const chans = JSON.parse(cfg.channel_ids);
      if (Array.isArray(chans) && chans.length && !chans.includes(message.channel.id)) return false;
    } catch { /* malformed = treat as all-channels */ }
  }

  const opts = await evaluateOptionsFor(cfg, message.guild.id, message.author.id);
  const hit = evaluateCommissionAd(message.content, opts);
  if (!hit) return false;

  // Borderline soft-sell: surface it, leave the message alone, let a moderator rule.
  if (hit.action === 'review') {
    const q = await queueForReview(message, hit, cfg).catch(err => {
      logger.error(`[CommissionFilter] review NOT recorded for ${message.id} in ${message.guild.id}: ${err.message}`, { category: 'automod' });
      return { queued: false, posted: false };
    });
    logger.info(`[CommissionFilter] flagged soft-sell (score ${hit.score}: ${hit.signals.join(',')}) from ${message.author.id} in ${message.guild.id}#${message.channel.id}`
      + (q.queued ? (q.posted ? ' — queued + posted' : ' — queued (dashboard only, no review channel)') : ' — NOT RECORDED'), { category: 'automod' });
    return false; // not deleted — caller should keep processing the message
  }

  const matched = hit.matched;

  // A moderator has already ruled on this exact message, this trigger, or this member. Their
  // decision outranks the filter permanently — that is what makes the undo stick.
  const exempt = await exemptionFor(message.guild.id, message, hit);
  if (exempt) {
    logger.info(`[CommissionFilter] skipped ${message.id} in ${message.guild.id} — ${exempt.kind} exemption (${exempt.value})`, { category: 'automod' });
    return false;
  }

  // Unified allowlist / global pause: the message stays (core/protection-exempt.js logs the skip).
  if (message.member && await protectionHold(message.member, 'delete', 'Commission filter')) return false;

  // Capture everything BEFORE deleting. Once the message is gone this is the only copy that
  // exists, and without it a disputed removal cannot be checked, explained or reversed.
  const record = {
    content: (message.content || '').slice(0, 4000),
    attachments: message.attachments?.size
      ? JSON.stringify([...message.attachments.values()].map(a => ({ name: a.name, url: a.url })))
      : null,
  };

  const deleted = await message.delete().then(() => true).catch(() => false);
  if (!deleted) {
    logger.warn(`[CommissionFilter] matched but could not delete in ${message.channel.id} (missing Manage Messages?)`, { category: 'automod' });
    return false;
  }

  pool.execute(
    'UPDATE commission_spam_config SET deleted_count = deleted_count + 1, last_hit_at = NOW() WHERE guild_id = ?',
    [message.guild.id]).catch(() => {});
  logger.info(`[CommissionFilter] deleted "${matched}" (${hit.via}${hit.rule ? `:${hit.rule}` : ''}${hit.score ? `, score ${hit.score}` : ''}) ad from ${message.author.id} in ${message.guild.id}#${message.channel.id}`, { category: 'automod' });

  // Every tier is logged, not just soft-sell. A phrase deletion used to leave nothing behind but a
  // counter, so "the bot ate my post" was unanswerable.
  let decisionId = null;
  try {
    const [res] = await pool.execute(
      `INSERT INTO commission_spam_decisions
         (guild_id, user_id, channel_id, message_id, content, attachments, score, signals,
          via, rule, matched, deleted, verdict, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'confirmed', NOW())`,
      [message.guild.id, message.author.id, message.channel.id, message.id,
       record.content, record.attachments, hit.score || 0, (hit.signals || []).join(','),
       hit.via, hit.rule || null, String(matched).slice(0, 255)]);
    decisionId = res.insertId;
  } catch (err) {
    logger.error(`[CommissionFilter] deletion NOT logged for ${message.id}: ${err.message}`, { category: 'automod' });
  }

  if (hit.via === 'soft-sell') {
    pool.execute('UPDATE commission_spam_config SET soft_sell_deleted_count = soft_sell_deleted_count + 1 WHERE guild_id = ?',
      [message.guild.id]).catch(() => {});
  }

  if (cfg.dm_user) {
    message.author.send(
      `Your message in **${message.guild.name}** was removed automatically — advertising paid commissions `
      + 'is against the server rules. If you believe this was a mistake, contact a moderator.').catch(() => {});
  }

  const logChannelId = cfg.log_channel_id || cfg.review_channel_id;
  if (logChannelId) {
    const ch = message.guild.channels.cache.get(logChannelId);
    if (ch?.isTextBased?.()) {
      const embed = new EmbedBuilder()
        .setColor(themeColor(message.guild?.id, 'warning'))
        .setTitle('🧹 Commission ad removed')
        .setDescription(record.content ? record.content.slice(0, 1024) : '*(no text — attachment only)*')
        .addFields(
          { name: 'User', value: `<@${message.author.id}> (${message.author.id})`, inline: true },
          { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
          { name: 'Tier', value: hit.via, inline: true },
          { name: hit.via === 'soft-sell' ? 'Signals' : 'Matched',
            value: hit.via === 'soft-sell' ? `score ${hit.score} — ${hit.signals.join(', ')}` : `\`${matched}\``,
            inline: false },
        )
        .setTimestamp();
      if (record.attachments) {
        const urls = JSON.parse(record.attachments).map(a => `[${a.name}](${a.url})`).join('\n').slice(0, 1024);
        embed.addFields({ name: 'Attachments', value: urls, inline: false });
      }
      if (decisionId) embed.setFooter({ text: `Removal #${decisionId} — wrong? Use the buttons to undo it permanently.` });

      const payload = { embeds: [embed] };
      if (decisionId) {
        payload.components = [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`commfp:${decisionId}`).setLabel('False positive — restore')
            .setEmoji('↩️').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`commoff:${decisionId}`).setLabel('Stop matching this')
            .setEmoji('🚫').setStyle(ButtonStyle.Secondary),
        )];
      }
      const sent = await ch.send(payload).catch(() => null);
      if (sent && decisionId) {
        pool.execute('UPDATE commission_spam_decisions SET log_message_id = ? WHERE id = ?', [sent.id, decisionId]).catch(() => {});
      }
    }
  }

  return true;
}

export default {
  checkMessage, invalidate, DEFAULT_PHRASES, PHRASE_GROUPS, PATTERN_RULES,
  getStats, getGlobalStats, groupsFor, matchCommissionAd, matchOptionsFor,
};
