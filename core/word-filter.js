/*
 * Filtered words: a matching message is deleted and nothing else happens automatically. The moderators get a
 * card in their channel with the content and Warn / Mute / Kick / Ban buttons (interactions/buttons/word_filter.js),
 * and the decision is theirs.
 *
 * Two layers, one list (dashboard → AutoMod → Filtered words, saved as an automod_rules row with
 * filter_type 'word_filter'; matching rules in core/word-filter-logic.js):
 *   native rule   Discord blocks the message before anyone sees it, and keeps doing so while the bot restarts.
 *                 Hits arrive as AutoMod executions: handleBlockedMessage.
 *   bot           events/messageCreate.js and messageUpdate.js: checkMessage. Reads what the native rule cannot:
 *                 lookalike letters, markdown tricks, forwarded messages.
 *
 * A member firing off messages gets one card and one ping: further hits within COALESCE_MS update it. It runs
 * ahead of the spam filters, so a repeated slur is deleted and flagged, not auto-timed-out behind the mods' backs.
 * Detections go in phishing_detections (source 'word_filter'); action_taken is the card's state, and moving it
 * off 'flagged' is what stops two moderators acting on one card.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { safeJsonObject } from '../utils/safeJson.js';
import { effectiveContent } from '../utils/message-effective-content.js';
import { themeColor } from './guild-theme.js';
import { isTicketChannel } from './ticket-channels.js';
import { isIgnoredChannel, protectionHold } from './protection-exempt.js';
import { actOrReport, reportManualAction } from './manual-action.js';
import { compileFilter, findEntry, nativeRuleSpec } from './word-filter-logic.js';

const SOURCE = 'Filtered words';
const RULE_TTL_MS = 60_000;
const COALESCE_MS = 5 * 60_000;
const REFRESH_MS = 3_000;
const SAMPLES = 3;

const ruleCache = new Map();   // guildId -> { at, rule }
const openCards = new Map();   // `${guildId}:${userId}` -> the card being added to

function toRule(row) {
    const config = safeJsonObject(row.config, 'word filter config');
    const words = Array.isArray(config.words) ? config.words : [];
    const exceptions = Array.isArray(config.allow) ? config.allow : [];
    return {
        id: row.id,
        enabled: !!row.is_enabled,
        words,
        exceptions,
        flagChannelId: config.flag_channel_id || null,
        pingRoleIds: Array.isArray(config.ping_role_ids) ? config.ping_role_ids : [],
        nativeRuleId: config.native_rule_id || null,
        filter: compileFilter(words, exceptions),
    };
}

async function loadRule(guildId) {
    const hit = ruleCache.get(guildId);
    if (hit && Date.now() - hit.at < RULE_TTL_MS) return hit.rule;
    const [rows] = await pool.execute(
        "SELECT id, is_enabled, config FROM automod_rules WHERE guild_id = ? AND filter_type = 'word_filter' ORDER BY id LIMIT 1",
        [guildId]
    );
    const rule = rows[0] ? toRule(rows[0]) : null;
    ruleCache.set(guildId, { at: Date.now(), rule });
    return rule;
}

// ── the card ─────────────────────────────────────────────────────────────────

export function cardButtons(detectionId, userId) {
    const button = (action, label, style) => new ButtonBuilder()
        .setCustomId(`wfilter:${action}:${detectionId}:${userId}`).setLabel(label).setStyle(style);
    return new ActionRowBuilder().addComponents(
        button('warn', 'Warn', ButtonStyle.Secondary),
        button('mute', 'Mute', ButtonStyle.Primary),
        button('kick', 'Kick', ButtonStyle.Danger),
        button('ban', 'Ban', ButtonStyle.Danger),
        button('dismiss', 'Dismiss', ButtonStyle.Success),
    );
}

export function cardEmbed(guild, card) {
    const { user, member, channel } = card;
    const created = user.createdTimestamp ? `<t:${Math.floor(user.createdTimestamp / 1000)}:R>` : 'unknown';
    const joined = member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'not in the server';
    const shown = card.samples.map(s => s.replace(/```/g, "'''").slice(0, 900)).join('\n---\n').slice(0, 2800);
    const state = card.blocked ? 'Blocked by Discord AutoMod' : 'Message deleted';
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, 'danger'))
        .setTitle(`Filtered word: ${card.removed ? state : 'could not delete the message'}`)
        .setDescription('```\n' + shown + '\n```')
        .addFields(
            { name: 'Member', value: `<@${user.id}> (${user.tag ?? user.username ?? user.id})`, inline: true },
            { name: 'Account created', value: created, inline: true },
            { name: 'Joined', value: joined, inline: true },
            { name: 'Channel', value: channel ? `${channel}` : 'unknown', inline: true },
            { name: 'Matched', value: `\`${String(card.entry).replace(/`/g, "'").slice(0, 60)}\``, inline: true },
            { name: 'Messages', value: String(card.hits), inline: true },
            { name: 'Record', value: card.record, inline: false },
        )
        .setTimestamp();
    if (card.detectionId) embed.setFooter({ text: `Detection #${card.detectionId} | User ID: ${user.id}` });
    return embed;
}

async function recordLine(guildId, userId) {
    const [rows] = await pool.execute('SELECT type, COUNT(*) AS n FROM infractions WHERE guild_id = ? AND user_id = ? GROUP BY type', [guildId, userId]);
    if (!rows.length) return 'No previous infractions';
    return rows.map(r => `${r.type}: ${r.n}`).join(', ').slice(0, 1024);
}

async function postCard(guild, rule, card) {
    const [res] = await pool.execute(
        `INSERT INTO phishing_detections (guild_id, user_id, channel_id, matched_domain, source, action_taken, message_id, content, evidence)
         VALUES (?, ?, ?, ?, 'word_filter', 'flagged', ?, ?, ?)`,
        [guild.id, card.user.id, card.channel?.id ?? '0', String(card.entry).slice(0, 255), card.messageId ?? null, card.samples[0].slice(0, 4000),
            JSON.stringify({ removed: card.removed, by: card.blocked ? 'discord' : 'bot' })]);
    card.detectionId = res.insertId;
    card.record = await recordLine(guild.id, card.user.id).catch(() => 'Unavailable');

    const channel = rule.flagChannelId ? guild.channels.cache.get(rule.flagChannelId) : null;
    if (channel?.isTextBased?.()) {
        const roles = rule.pingRoleIds.filter(id => guild.roles.cache.has(id));
        card.message = await channel.send({
            content: roles.map(id => `<@&${id}>`).join(' ') || undefined,
            embeds: [cardEmbed(guild, card)],
            components: [cardButtons(card.detectionId, card.user.id)],
            allowedMentions: { roles, parse: [] },
        }).catch((err) => { logger.warn(`[WordFilter] Card not posted in ${guild.id}: ${err.message}`); return null; });
    }
    if (!card.message) {
        await reportManualAction(guild, {
            action: 'flag', source: SOURCE, userId: card.user.id, channel: card.channel,
            problem: 'I removed a message but could not post the card for the moderators. Check the channel chosen under AutoMod → Filtered words.',
        });
    }
}

function refreshLater(guild, key, card) {
    if (card.timer || !card.message) return;
    card.timer = setTimeout(() => {
        card.timer = null;
        if (openCards.get(key) !== card) return;
        card.message.edit({ embeds: [cardEmbed(guild, card)] }).catch(() => {});
    }, REFRESH_MS);
    card.timer.unref?.();
}

async function flag(guild, rule, hit) {
    const now = Date.now();
    for (const [k, c] of openCards) if (now - c.lastHit >= COALESCE_MS) openCards.delete(k);

    const key = `${guild.id}:${hit.user.id}`;
    const open = openCards.get(key);
    if (open) {
        open.hits++;
        open.lastHit = now;
        open.samples = [...open.samples, hit.content].slice(-SAMPLES);
        open.removed = open.removed && hit.removed;
        await open.ready;
        refreshLater(guild, key, open);
        return;
    }
    const card = { ...hit, hits: 1, lastHit: now, samples: [hit.content], record: 'Unavailable', message: null, detectionId: null, timer: null };
    openCards.set(key, card);
    card.ready = postCard(guild, rule, card).catch(err => logger.error(`[WordFilter] Flag failed in ${guild.id}: ${err.message}`));
    await card.ready;
}

/** A moderator has dealt with this member: the next hit starts a new card, with a new ping. */
export function closeCard(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const card = openCards.get(key);
    if (card?.timer) clearTimeout(card.timer);
    openCards.delete(key);
}

export async function cardIsOpen(guildId, detectionId) {
    const [rows] = await pool.execute(
        "SELECT action_taken FROM phishing_detections WHERE id = ? AND guild_id = ? AND source = 'word_filter'", [detectionId, guildId]);
    return rows[0]?.action_taken === 'flagged';
}

/** @returns {Promise<boolean>} true for the one moderator who gets to act on this card */
export async function claimCard(guildId, detectionId) {
    const [res] = await pool.execute(
        "UPDATE phishing_detections SET action_taken = 'claimed' WHERE id = ? AND guild_id = ? AND source = 'word_filter' AND action_taken = 'flagged'",
        [detectionId, guildId]);
    return res.affectedRows === 1;
}

export async function settleCard(guildId, detectionId, outcome) {
    await pool.execute(
        "UPDATE phishing_detections SET action_taken = ? WHERE id = ? AND guild_id = ? AND source = 'word_filter'", [outcome, detectionId, guildId]);
}

// ── the two ways in ──────────────────────────────────────────────────────────

/**
 * Sent or edited message. @returns {Promise<boolean>} true when it was a hit: nothing else should process it
 */
export async function checkMessage(message) {
    const guild = message.guild;
    if (!guild || !message.author || message.author.bot || message.webhookId) return false;
    const rule = await loadRule(guild.id);
    if (!rule?.enabled || message.channel.id === rule.flagChannelId) return false;

    const content = effectiveContent(message);
    const entry = content ? findEntry(content, rule.filter) : null;
    if (!entry) return false;

    const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
    if (!member || guild.ownerId === member.id || member.permissions.has(PermissionFlagsBits.Administrator)) return false;
    if (await isTicketChannel(message.channel) || await isIgnoredChannel(message.channel)) return false;
    if (await protectionHold(member, 'delete', SOURCE)) return false;

    const removed = await actOrReport(guild, 'delete', { member, channel: message.channel, source: SOURCE }, () => message.delete());
    await flag(guild, rule, { user: message.author, member, channel: message.channel, content, entry, messageId: message.id, removed, blocked: false });
    return true;
}

/** Discord's native rule blocked a message, so no message event will come: the card is raised from here. */
export async function handleBlockedMessage(execution) {
    try {
        const guild = execution.guild;
        if (!guild || execution.action?.type !== 1) return;
        const rule = await loadRule(guild.id);
        if (!rule?.enabled || !rule.nativeRuleId || rule.nativeRuleId !== execution.ruleId) return;
        const member = execution.member ?? await guild.members.fetch(execution.userId).catch(() => null);
        const user = member?.user ?? await guild.client.users.fetch(execution.userId).catch(() => null);
        if (!user || user.bot) return;
        const content = execution.content || execution.matchedContent || '(content unavailable)';
        const entry = execution.matchedKeyword || findEntry(content, rule.filter) || 'Discord AutoMod pattern';
        const channel = execution.channelId ? guild.channels.cache.get(execution.channelId) ?? null : null;
        await flag(guild, rule, { user, member, channel, content, entry, messageId: null, removed: true, blocked: true });
    } catch (err) {
        logger.error(`[WordFilter] AutoMod execution not handled: ${err.message}`);
    }
}

// ── settings ─────────────────────────────────────────────────────────────────

export async function getSettings(guildId) {
    const rule = await loadRule(guildId);
    return rule
        ? { enabled: rule.enabled, words: rule.words, exceptions: rule.exceptions, flagChannelId: rule.flagChannelId, pingRoleIds: rule.pingRoleIds }
        : { enabled: false, words: [], exceptions: [], flagChannelId: null, pingRoleIds: [] };
}

async function syncNativeRule(guild, rule, settings) {
    const enabled = settings.enabled && settings.words.length > 0;
    const existing = rule?.nativeRuleId ? await guild.autoModerationRules.fetch(rule.nativeRuleId).catch(() => null) : null;
    if (!enabled && !existing) return { id: null };
    if (!settings.words.length) {
        await existing.edit({ enabled: false, reason: 'Filtered words saved on the dashboard' });
        return { id: existing.id };
    }
    const spec = nativeRuleSpec({ ...settings, enabled });
    const write = (s) => (existing ? existing.edit(s) : guild.autoModerationRules.create(s));
    const saved = await write(spec).catch(() => write({
        ...spec,
        triggerMetadata: { ...spec.triggerMetadata, regexPatterns: spec.triggerMetadata.regexPatterns.map(p => p.replace(/^\(\?i\)/, '')) },
    }));
    return { id: saved.id };
}

/**
 * Dashboard save. The bot's list is saved even when Discord refuses the native rule; the caller is told.
 * @returns {Promise<{ ok:boolean, error?:string, nativeError?:string }>}
 */
export async function saveSettings(guild, { enabled, words, exceptions, flagChannelId, pingRoleIds }, by = null) {
    if (flagChannelId && !guild.channels.cache.get(flagChannelId)?.isTextBased?.()) return { ok: false, error: 'bad_channel' };
    if (enabled && !flagChannelId) return { ok: false, error: 'no_channel' };
    const roles = pingRoleIds.filter(id => guild.roles.cache.has(id));
    ruleCache.delete(guild.id);
    const rule = await loadRule(guild.id);

    let nativeRuleId = rule?.nativeRuleId ?? null;
    let nativeError;
    try {
        nativeRuleId = (await syncNativeRule(guild, rule, { enabled, words, exceptions, flagChannelId })).id ?? nativeRuleId;
    } catch (err) {
        nativeError = err.message;
        logger.warn(`[WordFilter] Native rule not saved in ${guild.id}: ${err.message}`);
    }
    const config = JSON.stringify({ words, allow: exceptions, flag_channel_id: flagChannelId, ping_role_ids: roles, native_rule_id: nativeRuleId });
    if (rule) await pool.execute('UPDATE automod_rules SET is_enabled = ?, config = ? WHERE id = ? AND guild_id = ?', [enabled ? 1 : 0, config, rule.id, guild.id]);
    else await pool.execute("INSERT INTO automod_rules (guild_id, filter_type, is_enabled, config, action) VALUES (?, 'word_filter', ?, ?, 'delete')", [guild.id, enabled ? 1 : 0, config]);
    ruleCache.delete(guild.id);
    logger.info(`[WordFilter] Settings saved in ${guild.id} by ${by}: ${words.length} words, enabled=${!!enabled}`);
    return { ok: true, nativeError };
}

export default { checkMessage, handleBlockedMessage, getSettings, saveSettings, claimCard, settleCard, closeCard, cardIsOpen };
