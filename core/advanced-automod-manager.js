import { PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';
import { safeJsonArray } from '../utils/safeJson.js';
import { isProtectedFromBanCommands } from '../utils/owner-protection.js';
import { logAutomodAction } from './log-manager.js';
import { protectionHold } from './protection-exempt.js';
import { actOrReport } from './manual-action.js';
import { effectiveContent } from '../utils/message-effective-content.js';
import {
    validatePattern, matchPattern, compilePattern, PATTERN_TYPES, PATTERN_ACTIONS, MAX_PATTERNS_PER_GUILD,
} from './automod-patterns.js';

/*
 * Custom patterns (`automod_patterns`) are cached per guild, not in one process-wide Map.
 * Only rows with target = 'message' are message patterns; target = 'name' rows are name filters
 * (core/name-filters.js), and every query here is scoped so the two never mix.
 *
 * The old loader appended every enabled row to a Map on each call and never cleared it, so every
 * add/remove (which reloaded) duplicated the whole set, and messageCreate's instance was the only
 * copy — a pattern added from a command never reached it. Now each guild's list is loaded on
 * demand, compiled once, kept for PATTERN_CACHE_MS, and dropped the moment a command changes it.
 */
const PATTERN_CACHE_MS = 5 * 60 * 1000;
const patternCache = new Map(); // guildId -> { loadedAt, patterns: [{ ...row, compiled }] }

export async function getGuildPatterns(guildId) {
    const hit = patternCache.get(guildId);
    if (hit && Date.now() - hit.loadedAt < PATTERN_CACHE_MS) return hit.patterns;
    const [rows] = await pool.execute(
        "SELECT id, guild_id, pattern_type, pattern, action, reason FROM automod_patterns WHERE guild_id = ? AND target = 'message' AND enabled = 1 ORDER BY id",
        [guildId]
    );
    const patterns = [];
    for (const row of rows) {
        const compiled = compilePattern(row);
        if (row.pattern_type === 'regex' && !compiled) {
            logger.warn('[AdvancedAutomodManager] Skipping a stored regex that no longer compiles', { guildId, patternId: row.id });
            continue;
        }
        patterns.push({ ...row, compiled });
    }
    patternCache.set(guildId, { loadedAt: Date.now(), patterns });
    return patterns;
}

export function invalidateGuildPatterns(guildId) {
    if (guildId) patternCache.delete(guildId);
    else patternCache.clear();
}

/*
 * A server's word filter for text the bot posts on a member's behalf (/fun insult, Evil Insult lines
 * in custom commands): its enabled automod banned-word lists plus its message patterns, in the shape
 * core/hate-terms.js serverFilterHit / rejectReason take. Words are cached for a minute, patterns as
 * above. (Moved here from commands/fun/fun-insult-handler.js so core modules can share it.)
 */
const WORD_FILTER_TTL_MS = 60_000;
const wordFilterCache = new Map(); // guildId -> { at, words: [{ word, byWord }] }

async function guildBannedWords(guildId) {
    const hit = wordFilterCache.get(guildId);
    if (hit && Date.now() - hit.at < WORD_FILTER_TTL_MS) return hit.words;
    const words = [];
    try {
        const [rows] = await pool.execute('SELECT filter_type, config FROM automod_rules WHERE guild_id = ? AND is_enabled = 1', [guildId]);
        for (const row of rows) {
            if (!/^banned[_ ]?words?$/i.test(String(row.filter_type || ''))) continue;
            let cfg = row.config;
            try { cfg = typeof cfg === 'string' ? JSON.parse(cfg) : (cfg || {}); } catch { cfg = {}; }
            const byWord = (cfg.match_type ?? 'contains') === 'word';
            for (const word of (cfg.words ?? cfg.banned_words ?? [])) words.push({ word: String(word), byWord });
        }
    } catch (err) {
        logger.debug(`[AdvancedAutomodManager] banned words unavailable for ${guildId}: ${err.message}`);
    }
    wordFilterCache.set(guildId, { at: Date.now(), words });
    if (wordFilterCache.size > 2000) wordFilterCache.clear();
    return words;
}

/** { words, patterns } for core/hate-terms.js rejectReason. Never throws; {} parts on a DB error. */
export async function getGuildWordFilter(guildId) {
    if (!guildId) return { words: [], patterns: [] };
    const [words, patterns] = await Promise.all([
        guildBannedWords(guildId),
        getGuildPatterns(guildId).catch(() => []),
    ]);
    return { words, patterns };
}

/**
 * Count a pattern hit in spam_patterns_stats (unique on guild_id + pattern_id). Assignments in
 * ON DUPLICATE KEY UPDATE run left to right, so the score sees the incremented counter.
 */
export async function recordPatternHit(guildId, patternId) {
    try {
        await pool.execute(
            `INSERT INTO spam_patterns_stats (guild_id, pattern_id, true_positives, last_hit_at, effectiveness_score)
             VALUES (?, ?, 1, NOW(), 50)
             ON DUPLICATE KEY UPDATE
                true_positives = true_positives + 1,
                last_hit_at = NOW(),
                effectiveness_score = (true_positives / (true_positives + false_positives + 1)) * 100`,
            [guildId, patternId]
        );
    } catch (error) {
        logger.error('[AdvancedAutomodManager] Failed to record pattern hit', { guildId, patternId, error: error.message });
    }
}

/**
 * A moderator says a hit was wrong: move one hit from true to false positive.
 * @returns {Promise<boolean>} false when the pattern is not this guild's
 */
export async function markPatternFalsePositive(guildId, patternId) {
    const [owned] = await pool.execute('SELECT id FROM automod_patterns WHERE id = ? AND guild_id = ?', [patternId, guildId]);
    if (!owned.length) return false;
    await pool.execute(
        `INSERT INTO spam_patterns_stats (guild_id, pattern_id, false_positives, effectiveness_score)
         VALUES (?, ?, 1, 0)
         ON DUPLICATE KEY UPDATE
            true_positives = GREATEST(true_positives - 1, 0),
            false_positives = false_positives + 1,
            effectiveness_score = (true_positives / (true_positives + false_positives + 1)) * 100`,
        [guildId, patternId]
    );
    return true;
}

/**
 * Validate and store a pattern for a guild.
 * @returns {Promise<{ ok: true, id: number, value: string } | { ok: false, error: string }>}
 */
export async function addPattern(guildId, patternType, pattern, action = 'delete', reason = null, createdBy = null) {
    if (!PATTERN_ACTIONS.includes(action)) return { ok: false, error: `Unknown action "${action}".` };
    const check = validatePattern(patternType, pattern);
    if (!check.ok) return check;

    const [[{ count }]] = await pool.execute("SELECT COUNT(*) AS count FROM automod_patterns WHERE guild_id = ? AND target = 'message'", [guildId]);
    if (Number(count) >= MAX_PATTERNS_PER_GUILD) {
        return { ok: false, error: `This server already has ${MAX_PATTERNS_PER_GUILD} patterns. Remove one first.` };
    }
    const [dupes] = await pool.execute(
        "SELECT id FROM automod_patterns WHERE guild_id = ? AND target = 'message' AND pattern_type = ? AND pattern = ? LIMIT 1",
        [guildId, patternType, check.value]
    );
    if (dupes.length) return { ok: false, error: `That pattern already exists as #${dupes[0].id}.` };

    const [result] = await pool.execute(
        'INSERT INTO automod_patterns (guild_id, pattern_type, pattern, action, reason, enabled, created_by) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [guildId, patternType, check.value, action, reason ? String(reason).slice(0, 200) : null, createdBy]
    );
    invalidateGuildPatterns(guildId);
    logger.info('[AdvancedAutomodManager] Pattern added', { guildId, patternId: result.insertId, patternType, action, createdBy });
    return { ok: true, id: result.insertId, value: check.value };
}

/** Remove a pattern (its stats rows cascade). Scoped to the guild so one server cannot delete another's. */
export async function removePattern(guildId, patternId) {
    const [result] = await pool.execute("DELETE FROM automod_patterns WHERE id = ? AND guild_id = ? AND target = 'message'", [patternId, guildId]);
    invalidateGuildPatterns(guildId);
    if (result.affectedRows) logger.info('[AdvancedAutomodManager] Pattern removed', { guildId, patternId });
    return result.affectedRows > 0;
}

/** Enable or disable a pattern without losing its statistics. */
export async function setPatternEnabled(guildId, patternId, enabled, disabledReason = null) {
    const [result] = await pool.execute(
        "UPDATE automod_patterns SET enabled = ?, disabled_reason = ? WHERE id = ? AND guild_id = ? AND target = 'message'",
        [enabled ? 1 : 0, enabled ? null : (disabledReason ? String(disabledReason).slice(0, 200) : null), patternId, guildId]
    );
    invalidateGuildPatterns(guildId);
    return result.affectedRows > 0;
}

/** Every pattern of a guild (enabled or not) with its hit counters. */
export async function listPatterns(guildId) {
    const [rows] = await pool.execute(
        `SELECT p.id, p.pattern_type, p.pattern, p.action, p.reason, p.enabled, p.disabled_reason, p.created_by, p.created_at,
                COALESCE(s.true_positives, 0) AS true_positives, COALESCE(s.false_positives, 0) AS false_positives,
                s.last_hit_at, s.effectiveness_score
           FROM automod_patterns p
           LEFT JOIN spam_patterns_stats s ON s.pattern_id = p.id AND s.guild_id = p.guild_id
          WHERE p.guild_id = ? AND p.target = 'message'
          ORDER BY p.id`,
        [guildId]
    );
    return rows;
}

export { PATTERN_TYPES, PATTERN_ACTIONS };

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const CUSTOM_EMOJI_MARK = '\u{E000}'; // private-use stand-in so a custom emoji is one grapheme
const isEmoji = (g) => g === CUSTOM_EMOJI_MARK || /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g);

/**
 * Why a message is an emoji wall, or null. Emojis are counted as people see them (one
 * grapheme each, so ⚔️ and 👨‍👩‍👧 are one apiece). A message trips only when more than
 * `max` emojis sit in one unbroken run (whitespace doesn't break it), or when it has more
 * than `max` emojis AND more emojis than words. Emojis spread through text never trip.
 */
export function findEmojiWall(content, max) {
    if (!content || !(max > 0)) return null;
    const text = content.replace(CUSTOM_EMOJI, CUSTOM_EMOJI_MARK);
    let total = 0, run = 0, longest = 0;
    for (const { segment } of graphemes.segment(text)) {
        if (isEmoji(segment)) {
            total++;
            run++;
            if (run > longest) longest = run;
        } else if (!/^\s+$/u.test(segment)) {
            run = 0;
        }
    }
    if (longest > max) return `${longest} emojis in a row (limit ${max})`;
    const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
    if (total > max && total > words) return `${total} emojis to ${words} words (limit ${max})`;
    return null;
}

class AdvancedAutomodManager {
    constructor(client) {
        this.client = client;
        this.spamTracking = new Map();
        this.MAX_SPAM_TRACKING = 5000; // Prevent unbounded growth
        logger.info('[AdvancedAutomodManager] Advanced automod manager initialized');
    }

    /**
     * Drop every cached pattern list so the next message in each guild reloads from the
     * database. Kept for callers of the old API; there is no longer a process-wide list to fill.
     */
    async loadPatterns() {
        invalidateGuildPatterns();
    }

    /**
     * Staff exemptions are configured on automod_rules (ignored_roles / ignored_channels);
     * automod_spam_config has no columns of its own for them. core/automod.js already
     * honours those lists, so this path has to read the same rows or a guild's exempt
     * mods get muted by the advanced checks despite being exempt everywhere else.
     */
    async getExemptions(guildId) {
        return configCache.get('automod_rules_exemptions', guildId, async () => {
            const [rows] = await pool.execute(
                'SELECT ignored_roles, ignored_channels FROM automod_rules WHERE guild_id = ? AND is_enabled = 1',
                [guildId]
            );
            const roles = new Set();
            const channels = new Set();
            for (const row of rows) {
                for (const id of safeJsonArray(row.ignored_roles, 'automod ignored_roles')) roles.add(id);
                for (const id of safeJsonArray(row.ignored_channels, 'automod ignored_channels')) channels.add(id);
            }
            return { roles: [...roles], channels: [...channels] };
        });
    }

    async checkMessage(message) {
        if (!message.guild || message.author.bot) return false;

        // Skip automod for users with Administrator permission or guild owners
        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = message.member.id === message.guild.ownerId;
            if (isAdmin || isOwner) return false;
        }

        const exempt = await this.getExemptions(message.guild.id);
        if (exempt.channels.includes(message.channel.id)) return false;
        if (message.member?.roles.cache.some(role => exempt.roles.includes(role.id))) return false;

        const guildId = message.guild.id;
        // Forwarded-aware content so forwarded scam links / NSFW aren't exempt
        // from pattern + duplicate + emoji-wall checks.
        const content = effectiveContent(message);

        // Check spam. The result must propagate: when checkSpam acts it has already
        // deleted the message and timed the member out, and messageCreate uses this
        // return value to stop. Swallowing it let the adaptive spam layer punish the
        // same message a second time.
        if (await this.checkSpam(message)) return true;

        // Check the guild's custom patterns
        if (!content) return false;
        let patterns;
        try {
            patterns = await getGuildPatterns(guildId);
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Failed to load patterns: ${error.message}`, { guildId });
            return false;
        }
        for (const pattern of patterns) {
            if (await this.matchesPattern(message, content, pattern)) {
                await recordPatternHit(guildId, pattern.id);
                await this.executeAction(message, pattern);
                return true;
            }
        }

        return false;
    }

    /**
     * True when the pattern matches. A regex that hits the time limit is switched off for the
     * guild (and the guild is told why) — it would cost the same on the next message.
     */
    async matchesPattern(message, content, pattern) {
        const result = matchPattern(pattern, content, pattern.compiled);
        if (result.timedOut) {
            logger.warn('[AdvancedAutomodManager] Regex pattern timed out; disabling it', {
                guildId: message.guild.id, patternId: pattern.id
            });
            await setPatternEnabled(message.guild.id, pattern.id, false, 'Disabled automatically: too slow to evaluate')
                .catch(err => logger.error('[AdvancedAutomodManager] Failed to disable slow pattern', { patternId: pattern.id, error: err.message }));
            await logAutomodAction(message.guild, message.client.user, 'Pattern disabled',
                `Custom pattern #${pattern.id} took too long to evaluate and was switched off. Rewrite it more simply, then re-enable it with /protection spam pattern-toggle.`,
                { source: 'Automod patterns' })
                .catch(err => logger.warn(`[AdvancedAutomodManager] Failed to post pattern-disabled log: ${err.message}`));
            return false;
        }
        if (result.error) {
            logger.error(`[AdvancedAutomodManager] Pattern match error: ${result.error.message}`, { patternId: pattern.id });
            return false;
        }
        return result.matched;
    }

    async checkSpam(message) {
        try {
            if (!message.guild) return false;

            // Use cached config lookup (60s TTL)
            const config = await configCache.get('automod_spam_config', message.guild.id, async () => {
                const [[result]] = await pool.execute('SELECT * FROM automod_spam_config WHERE guild_id = ? AND enabled = 1', [message.guild.id]);
                return result || null;
            });

            if (!config) {
                return false;
            }

            const content = effectiveContent(message);
            const userId = message.author.id;
            const guildId = message.guild.id;
            const key = `${guildId}_${userId}`;

            // Initialize tracking with max size enforcement
            if (!this.spamTracking.has(key)) {
                if (this.spamTracking.size >= this.MAX_SPAM_TRACKING) {
                    const oldestKey = this.spamTracking.keys().next().value;
                    this.spamTracking.delete(oldestKey);
                }
                this.spamTracking.set(key, { messages: [], lastCleanup: Date.now() });
            }

            const tracking = this.spamTracking.get(key);
            const now = Date.now();

            // Cleanup old messages
            tracking.messages = tracking.messages.filter(m => now - m.timestamp < config.time_window * 1000);

            // Add current message. Uses effective content so forwarded duplicates still trip the check.
            tracking.messages.push({ timestamp: now, content });

            // Check message spam
            if (tracking.messages.length > config.max_messages) {
                logger.info(`[AdvancedAutomodManager] Message spam detected: ${tracking.messages.length} messages in ${config.time_window}s`, {
                    guildId: message.guild.id,
                    userId: message.author.id,
                    channelId: message.channel.id,
                    threshold: config.max_messages
                });
                await this.executeSpamAction(message, config, 'message_spam');
                this.spamTracking.delete(key);
                return true;
            }

            // Check repeated messages
            const recentContent = tracking.messages.map(m => m.content);
            const duplicates = recentContent.filter(c => c === content).length;
            if (duplicates > 3) {
                logger.info(`[AdvancedAutomodManager] Repeated spam detected: ${duplicates} duplicate messages`, {
                    guildId: message.guild.id,
                    userId: message.author.id,
                    channelId: message.channel.id
                });
                await this.executeSpamAction(message, config, 'repeated_spam');
                this.spamTracking.delete(key);
                return true;
            }

            // Check mention spam. Discord preserves @mentions inside forwarded
            // snapshots as plain text (ping doesn't fire), so counting them in
            // the effective content catches mention-raid-via-forward too.
            const mentions = (content.match(/<@!?\d+>/g) || []).length;
            if (mentions > config.max_mentions) {
                logger.info(`[AdvancedAutomodManager] Mention spam detected: ${mentions} mentions`, {
                    guildId: message.guild.id,
                    userId: message.author.id,
                    channelId: message.channel.id,
                    threshold: config.max_mentions
                });
                await this.executeSpamAction(message, config, 'mention_spam');
                return true;
            }

            // Check emoji spam — an emoji WALL, not an emoji count.
            //
            // This used to total every emoji in the message and mute past max_emojis. A self-promo
            // post with one emoji at the start of each line ("👀🎮 NICE NATION…", "📝 SATURDAY…",
            // "⚔️ SUNDAY…") had 13 and its author was deleted and timed out for decorating an
            // announcement. It also counted code points, not emojis: ⚔️ is U+2694 + U+FE0F, so it
            // counted twice, and a ZWJ family 👨‍👩‍👧 counted five times.
            //
            // Spam is a run of emojis with nothing between them, or a message that is mostly emoji.
            const wall = findEmojiWall(content, config.max_emojis);
            if (wall) {
                logger.info(`[AdvancedAutomodManager] Emoji spam detected: ${wall}`, {
                    guildId: message.guild.id,
                    userId: message.author.id,
                    channelId: message.channel.id,
                    threshold: config.max_emojis
                });
                await this.executeSpamAction(message, config, 'emoji_spam', wall);
                return true;
            }

            // Check character spam — CONSECUTIVE runs, not total occurrences.
            //
            // This counted how many times each character appeared ANYWHERE in the message, so with
            // the default threshold of 15 any message containing 16 spaces — about seventeen words
            // of ordinary English — was "character spam" and earned a mute. The letter 'e' does it
            // just as easily. A member answering a support ticket with
            //   "Putting manually the dll file does have work the server don't automatically close
            //    and do not require steam running thanks"
            // has nineteen spaces in it, and was muted twice for writing a sentence.
            //
            // Character spam is "aaaaaaaaaaaaaaaa" or "!!!!!!!!!!!!!!!!" — the same character in an
            // unbroken run. Whitespace is excluded outright: repeated spaces and newlines are
            // formatting, and no amount of them is abuse worth a timeout.
            let runChar = null;
            let runLength = 0;
            for (const char of content) {
                if (char !== runChar) {
                    runChar = char;
                    runLength = 1;
                    continue;
                }
                runLength++;
                if (/\s/.test(char)) continue;
                if (runLength > config.max_repeated_chars) {
                    logger.info(`[AdvancedAutomodManager] Character spam detected: '${char}' repeated ${runLength} times in a row`, {
                        guildId: message.guild.id,
                        userId: message.author.id,
                        channelId: message.channel.id,
                        threshold: config.max_repeated_chars
                    });
                    await this.executeSpamAction(message, config, 'character_spam');
                    return true;
                }
            }

            return false;
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Spam check error: ${error.message}`, { guildId: message.guild?.id, userId: message.author.id });
            return false;
        }
    }

    /*
     * Rule actions (pattern and spam) go through actOrReport (core/manual-action.js): when the bot lacks the
     * permission or sits below the member, staff get the shared "Manual action needed" alert (throttled per
     * server and cause) and the step is not logged as done, instead of failing silently or as a bare error.
     */
    async executeAction(message, pattern) {
        try {
            // Unified allowlist / global pause (core/protection-exempt.js logs the skip).
            const doing = { mute: 'timeout', kick: 'kick', ban: 'ban' }[pattern.action] || 'delete';
            if (message.member && await protectionHold(message.member, doing, `Automod pattern #${pattern.id}`)) return;

            const ctx = { member: message.member, channel: message.channel, source: `Automod pattern #${pattern.id}` };
            await actOrReport(message.guild, 'delete', ctx, () => message.delete());

            if (isProtectedFromBanCommands(message.author?.id)) {
                return;
            }

            const reason = pattern.reason || 'Automod pattern match';

            if (pattern.action === 'warn') {
                await message.channel.send(`${message.author}, warned for: ${reason}`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
            } else if (pattern.action === 'mute') {
                const muteDuration = 10 * 60 * 1000;
                if (!await actOrReport(message.guild, 'timeout', ctx, () => message.member.timeout(muteDuration, reason))) return;
                await message.channel.send(`${message.author} has been muted for 10 minutes: ${reason}`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
            } else if (pattern.action === 'kick') {
                if (!await actOrReport(message.guild, 'kick', ctx, () => message.member.kick(reason))) return;
            } else if (pattern.action === 'ban') {
                if (!await actOrReport(message.guild, 'ban', ctx, () => message.member.ban({ reason, deleteMessageSeconds: 86400 }))) return;
            }

            logger.info(`[AdvancedAutomodManager] Executed ${pattern.action} on ${message.author.tag}`, { guildId: message.guild?.id, userId: message.author.id, reason, patternId: pattern.id });

            // Surface it in the guild's log channel, with the id a moderator needs to report a misfire.
            const actionLabel = { delete: 'Delete', warn: 'Warn', mute: 'Mute', kick: 'Kick', ban: 'Ban' }[pattern.action] || 'Delete';
            await logAutomodAction(message.guild, message.author, actionLabel,
                `${reason}\nPattern #${pattern.id} (${pattern.pattern_type}). Wrong call? /protection spam pattern-false-positive id:${pattern.id}`,
                { durationMinutes: pattern.action === 'mute' ? 10 : null, source: `Custom pattern #${pattern.id}`, channel: message.channel })
                .catch(err => logger.warn(`[AdvancedAutomodManager] Failed to post automod log: ${err.message}`));
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Action execution error: ${error.message}`, { action: pattern.action, guildId: message.guild?.id });
        }
    }

    async executeSpamAction(message, config, spamType, detail = null) {
        try {
            const doing = { mute: 'timeout', kick: 'kick' }[config.action] || 'delete';
            if (message.member && await protectionHold(message.member, doing, 'Advanced automod spam')) return;

            const ctx = { member: message.member, channel: message.channel, source: 'Advanced automod spam' };
            await actOrReport(message.guild, 'delete', ctx, () => message.delete());

            if (isProtectedFromBanCommands(message.author?.id)) {
                return;
            }

            const reason = detail ? `Spam detected: ${spamType} (${detail})` : `Spam detected: ${spamType}`;
            let durationMinutes = null;

            if (config.action === 'warn') {
                await message.channel.send(`${message.author}, stop spamming!`).then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
            } else if (config.action === 'mute') {
                durationMinutes = 10;
                if (!await actOrReport(message.guild, 'timeout', ctx, () => message.member.timeout(durationMinutes * 60 * 1000, reason))) return;
                await message.channel.send(`${message.author} has been muted for spamming.`).then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
            } else if (config.action === 'kick') {
                if (!await actOrReport(message.guild, 'kick', ctx, () => message.member.kick(reason))) return;
            }

            logger.info(`[AdvancedAutomodManager] Spam action ${config.action} on ${message.author.tag}`, { guildId: message.guild?.id, userId: message.author.id, spamType });

            // Surface the action in the guild's log channel. Winston alone left moderators
            // with muted members and no record of why.
            const actionLabel = { warn: 'Warn', mute: 'Mute', kick: 'Kick' }[config.action] || 'Delete';
            await logAutomodAction(message.guild, message.author, actionLabel, reason, {
                durationMinutes, source: 'Advanced Automod', channel: message.channel
            }).catch(err => logger.warn(`[AdvancedAutomodManager] Failed to post automod log: ${err.message}`));
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Spam action error: ${error.message}`, { guildId: message.guild?.id });
        }
    }

    async addPattern(guildId, patternType, pattern, action, reason, createdBy = null) {
        try {
            return (await addPattern(guildId, patternType, pattern, action, reason, createdBy)).ok === true;
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Failed to add pattern: ${error.message}`, { guildId });
            return false;
        }
    }

    async removePattern(patternId, guildId) {
        try {
            if (!guildId) {
                // Old signature (id only). Resolve the owner so the delete stays guild-scoped.
                const [rows] = await pool.execute("SELECT guild_id FROM automod_patterns WHERE id = ? AND target = 'message'", [patternId]);
                if (!rows.length) return false;
                guildId = rows[0].guild_id;
            }
            return await removePattern(guildId, patternId);
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Failed to remove pattern: ${error.message}`);
            return false;
        }
    }
}

export default AdvancedAutomodManager;
