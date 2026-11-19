import { PermissionFlagsBits } from 'discord.js';
import { isTicketChannel } from './ticket-channels.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logInfraction, sendModerationDm } from './moderation-manager.js';
import { logAutomodAction } from './log-manager.js';
import { safeJsonArray, safeJsonObject, safeJsonParse } from '../utils/safeJson.js';
import { isProtectedFromBanCommands } from '../utils/owner-protection.js';
import { protectionHold } from './protection-exempt.js';
import { actOrReport } from './manual-action.js';
import { foldConfusables } from '../utils/text-fold.js';
import { effectiveContent } from '../utils/message-effective-content.js';

// Memory limits to prevent unbounded growth
const MAX_RULES_CACHE = 5000;
const MAX_HEAT_CONFIG_CACHE = 5000;
const MAX_HEAT_CACHE = 50000;
const MAX_ANTI_SPAM_CACHE = 50000;
const MAX_FILTERED_USERS = 10000;

// Caches for configs and user heat levels
const rulesCache = new Map();
const heatConfigCache = new Map();
const heatCache = new Map();

// Anti-spam tracking: Map<`${guildId}:${userId}`, { messages: { content: string, timestamp: number }[] }>
const antiSpamCache = new Map();

// Filtered users: Users currently in "spam filter" mode
// Map<`${guildId}:${userId}`, {
//   filteredAt: timestamp,
//   lastMessage: timestamp,
//   messagesDeleted: number,
//   rule: object,
//   client: Client,
//   channelId: string,
//   releaseTimer: NodeJS.Timeout
// }>
const filteredUsers = new Map();

// Helper to enforce max size on Maps with FIFO eviction
function enforceMaxSize(map, maxSize, mapName) {
    if (map.size > maxSize) {
        const entriesToDelete = map.size - maxSize;
        const iterator = map.keys();
        for (let i = 0; i < entriesToDelete; i++) {
            const key = iterator.next().value;
            map.delete(key);
        }
        logger.debug(`[Automod] ${mapName} evicted ${entriesToDelete} entries (size: ${map.size}/${maxSize})`);
    }
}

// Cooldown period before user is released from filter (1 minute)
const FILTER_COOLDOWN_MS = 60 * 1000;

// Every delete / timeout / kick / ban below goes through actOrReport (core/manual-action.js): when the bot
// lacks the permission or sits below the member, staff get the shared "Manual action needed" alert naming
// exactly what to fix (throttled per server and cause) instead of the step failing silently.
const SPAM_SOURCE = 'Automod spam filter';
const HEAT_SOURCE = 'Automod heat';

// Escalating timeout durations in minutes based on violation count
const ESCALATING_TIMEOUTS = [
    1,      // 1st violation: 1 minute
    5,      // 2nd violation: 5 minutes
    15,     // 3rd violation: 15 minutes
    30,     // 4th violation: 30 minutes
    60,     // 5th violation: 1 hour
    120,    // 6th violation: 2 hours
    360,    // 7th violation: 6 hours
    720,    // 8th violation: 12 hours
    1440,   // 9th+ violation: 24 hours
];

/**
 * What a Message spam rule does once it fires (register H-659). The repeated messages are always deleted,
 * and the sender's messages keep being deleted until they stop for a minute; then:
 *   ladder  time out for longer each time (ESCALATING_TIMEOUTS, counted over 24 hours), applied when the
 *           burst stops. What every Delete / Warn / Mute spam rule did before; migration 443 moved them here.
 *   delete  nothing more
 *   warn    a warning (infraction + Moderation page DM), straight away
 *   mute    a timeout of the rule's length, straight away
 *   kick / ban  remove the sender straight away (the ladder runs if the bot cannot)
 */
export const SPAM_ACTIONS = Object.freeze(['ladder', 'delete', 'warn', 'mute', 'kick', 'ban']);
export const spamRuleAction = (rule) => (SPAM_ACTIONS.includes(String(rule?.action)) ? String(rule.action) : 'ladder');

/** The ladder's timeout for a member with `violations` earlier spam timeouts in the last 24 hours. */
export const spamLadderMinutes = (violations) =>
    ESCALATING_TIMEOUTS[Math.min(Math.max(Number(violations) || 0, 0), ESCALATING_TIMEOUTS.length - 1)];

/** Drop a guild's cached rules and heat config (the dashboard calls this after saving a rule). */
export function invalidateAutomodRules(guildId) {
    rulesCache.delete(guildId);
    heatConfigCache.delete(guildId);
}

// Clear config caches periodically (every 5 minutes)
setInterval(() => {
    rulesCache.clear();
    heatConfigCache.clear();
}, 5 * 60 * 1000);

// Clean up old anti-spam tracking data and enforce max sizes every minute
setInterval(() => {
    const now = Date.now();

    // Clean expired anti-spam entries
    for (const [key, data] of antiSpamCache.entries()) {
        // Remove entries older than 60 seconds
        data.messages = data.messages.filter(msg => now - msg.timestamp < 60000);
        if (data.messages.length === 0) {
            antiSpamCache.delete(key);
        }
    }

    // Clean expired filtered users (older than 10 minutes)
    for (const [key, data] of filteredUsers.entries()) {
        if (now - data.filteredAt > 10 * 60 * 1000) {
            if (data.releaseTimer) clearTimeout(data.releaseTimer);
            filteredUsers.delete(key);
        }
    }

    // Clean expired heat entries (older than 1 hour)
    for (const [key, data] of heatCache.entries()) {
        if (data.timestamp && now - data.timestamp > 60 * 60 * 1000) {
            heatCache.delete(key);
        }
    }

    // Enforce max sizes on all caches
    enforceMaxSize(rulesCache, MAX_RULES_CACHE, 'rulesCache');
    enforceMaxSize(heatConfigCache, MAX_HEAT_CONFIG_CACHE, 'heatConfigCache');
    enforceMaxSize(heatCache, MAX_HEAT_CACHE, 'heatCache');
    enforceMaxSize(antiSpamCache, MAX_ANTI_SPAM_CACHE, 'antiSpamCache');
    enforceMaxSize(filteredUsers, MAX_FILTERED_USERS, 'filteredUsers');
}, 60000);

/**
 * Normalize message content for spam comparison
 * Makes it so "hello" "HELLO" "  hello  " are all treated the same
 */
function normalizeMessageContent(content) {
    if (!content) return '';

    // utils/text-fold.js: lower case, whitespace collapsed, zero-width and other invisible characters
    // removed, accents / zalgo stripped and lookalike letters (Cyrillic, small caps, maths fonts...)
    // folded, so a repeated message cannot dodge the duplicate check by restyling itself.
    return foldConfusables(content);
}

/**
 * Check if two messages are similar enough to be considered the same spam
 * Returns true if messages are 80%+ similar
 */
function areMessagesSimilar(msg1, msg2) {
    if (msg1 === msg2) return true;
    if (!msg1 || !msg2) return false;

    // For very short messages (under 8 chars), require exact match.
    // This prevents "ok" "lol" "yes" "no" etc from matching each other.
    if (msg1.length < 8 || msg2.length < 8) {
        return msg1 === msg2;
    }

    const shorter = msg1.length <= msg2.length ? msg1 : msg2;
    const longer = msg1.length > msg2.length ? msg1 : msg2;

    // Repetition spam: the shorter is contained in the longer and makes up most of it.
    // Catches "😂😂😂" vs "😂😂😂😂😂" and a message resent with a word appended.
    if (longer.includes(shorter) && shorter.length >= longer.length * 0.5) {
        return true;
    }

    // WORD sequences, not character pairs.
    //
    // This used to be Sørensen–Dice over character bigrams, which measures shared VOCABULARY rather
    // than repetition. Two long English sentences share almost every common character pair ("th",
    // "he", "e ", "in", "er"…), so the score climbs with length and topic rather than with sameness:
    // two genuinely different messages in one support conversation —
    //   "Putting manually the dll file does have work the server don't automatically close…"
    //   "the server does not automatically close and does not require steam to be running"
    // — scored 81%, over the 80% line, and got somebody muted for answering their own ticket.
    //
    // Overlapping three-word shingles fix that. People re-explaining a problem reuse the words but
    // not the word ORDER; somebody pasting the same message twice reproduces both. Unrelated English
    // scores near zero here instead of the 40-50% the character measure gave it.
    const shingles = (str) => {
        const words = str.split(/\s+/).filter(Boolean);
        const out = new Set();
        if (words.length < 3) {
            // Too short to shingle — fall back to the whole normalised string.
            out.add(words.join(' '));
            return out;
        }
        for (let i = 0; i <= words.length - 3; i++) out.add(words.slice(i, i + 3).join(' '));
        return out;
    };

    const s1 = shingles(msg1);
    const s2 = shingles(msg2);

    let intersection = 0;
    for (const sh of s1) {
        if (s2.has(sh)) intersection++;
    }

    // Dice over shingles. 0.6 is deliberately lower than the old 0.8 because the measure is far
    // stricter: sharing 60% of three-word sequences means most of the sentence is literally the same
    // run of words, which is repetition, not a coincidence of topic.
    const similarity = (2 * intersection) / (s1.size + s2.size);
    return similarity >= 0.6;
}


/**
 * Rules are written by several producers that disagree on casing: the dashboard writes
 * camelCase filter types, the setup scripts write snake_case. The switch below only ever
 * matched camelCase, so every snake_case rule silently did nothing.
 * The canonical stored values are the dashboard's: banned_words, mass_mentions, all_caps,
 * anti_spam and discord_invites. Older writers stored 'spam' (guild setup scripts) and 'invite'
 * (the takeover catalogue); those rows did nothing until they were mapped here (H-105).
 */
const FILTER_TYPE_ALIASES = {
    anti_spam: 'antiSpam',
    antispam: 'antiSpam',
    spam: 'antiSpam',
    invite: 'discordInvites',
    banned_words: 'bannedWords',
    bannedwords: 'bannedWords',
    discord_invites: 'discordInvites',
    discordinvites: 'discordInvites',
    invites: 'discordInvites',
    mass_mentions: 'massMention',
    mass_mention: 'massMention',
    massmentions: 'massMention',
    all_caps: 'allCaps',
    allcaps: 'allCaps',
    caps: 'allCaps',
};

function canonicalFilterType(filterType) {
    if (!filterType) return '';
    return FILTER_TYPE_ALIASES[String(filterType).toLowerCase()] || filterType;
}

/**
 * heat_values is keyed by short names ("banned_word", "invite", "mention", "caps") by the
 * setup scripts but by violation type ("bannedWords", ...) elsewhere. Check both before
 * falling back, otherwise every violation contributed 1 heat instead of its configured weight.
 */
const HEAT_VALUE_ALIASES = {
    bannedWords: ['bannedWords', 'banned_words', 'banned_word'],
    discordInvites: ['discordInvites', 'discord_invites', 'invite', 'invites'],
    massMention: ['massMention', 'mass_mentions', 'mention', 'mentions'],
    allCaps: ['allCaps', 'all_caps', 'caps'],
};

function heatValueFor(heatValues, violationType) {
    for (const key of HEAT_VALUE_ALIASES[violationType] || [violationType]) {
        if (typeof heatValues[key] === 'number') return heatValues[key];
    }
    return 1;
}

/**
 * action_thresholds is stored either as an array of {type, threshold, duration} or as an
 * object keyed by action name ({"warn":25,"mute_5min":50,"kick":100,"ban":150}). Only the
 * array form was ever parsed, so object-form guilds never triggered a single heat action.
 * Returns a normalised array sorted highest-threshold-first.
 */
function parseActionThresholds(raw) {
    const parsed = safeJsonParse(raw, null, 'automod action_thresholds');
    if (!parsed || typeof parsed !== 'object') return [];

    let actions;
    if (Array.isArray(parsed)) {
        actions = parsed.filter(a => a && typeof a.threshold === 'number');
    } else {
        actions = Object.entries(parsed).map(([name, threshold]) => {
            if (typeof threshold !== 'number') return null;
            // "mute_5min" / "mute_30min" carry their duration in the key.
            const muteMatch = /^mute[_-]?(\d+)\s*min/i.exec(name);
            if (muteMatch) return { type: 'mute', threshold, duration: parseInt(muteMatch[1], 10) };
            const type = String(name).toLowerCase().replace(/[_-].*$/, '');
            if (!['warn', 'mute', 'kick', 'ban'].includes(type)) return null;
            return { type, threshold, duration: type === 'mute' ? 10 : undefined };
        }).filter(Boolean);
    }

    return actions.sort((a, b) => b.threshold - a.threshold);
}

export async function processMessage(message) {
    if (!message.guild || message.author.bot || !message.member) return;

    // Skip automod for users with Administrator permission or guild owners
    const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
    const isOwner = message.member.id === message.guild.ownerId;
    if (isAdmin || isOwner) return;

    // A support ticket is never spam, and this check has to come BEFORE the filtered-user branch
    // below — that branch deletes every message from a flagged member regardless of content, so
    // somebody flagged elsewhere would have their answers to their OWN support ticket deleted as
    // they typed them. Which is what happened: a member replying in their open ticket with a note
    // about a DLL and Steam had it removed and was muted.
    if (await isTicketChannel(message.channel)) return;

    const guildId = message.guild.id;
    const userKey = `${guildId}:${message.author.id}`;

    // Check if user is currently in filtered mode
    if (filteredUsers.has(userKey)) {
        const filterData = filteredUsers.get(userKey);
        const now = Date.now();

        // Delete the message immediately
        await actOrReport(message.guild, 'delete', { member: message.member, channel: message.channel, source: SPAM_SOURCE }, () => message.delete());
        filterData.messagesDeleted++;
        filterData.lastMessage = now;

        logger.debug(`[Automod-AntiSpam] Deleted message from filtered user ${message.author.tag} (${filterData.messagesDeleted} total deleted)`, {
            guildId,
            userId: message.author.id
        });

        // Reset the release timer
        if (filterData.releaseTimer) {
            clearTimeout(filterData.releaseTimer);
        }
        filterData.releaseTimer = setTimeout(() => {
            releaseFilteredUser(userKey, message.client);
        }, FILTER_COOLDOWN_MS);

        return; // Don't process further while filtered
    }

    // Fetch and cache automod rules
    let rules = rulesCache.get(guildId);
    if (rules === undefined) {
        const [dbRules] = await pool.execute('SELECT * FROM automod_rules WHERE guild_id = ? AND is_enabled = 1', [guildId]);
        rules = dbRules || [];
        rulesCache.set(guildId, rules);
    }

    if (rules.length === 0) return;

    // Ignored roles and channels belong to each rule (set per rule on the AutoMod page). They used to be
    // pooled, so a role ignored by one rule silently skipped every rule.

    // First, check antiSpam rules (these work independently of heat config)
    for (const rule of rules) {
        if (canonicalFilterType(rule.filter_type) !== 'antiSpam') continue;
        if (ruleSkips(rule, message)) continue;

        const config = safeJsonObject(rule.config, 'automod rule config');
        // Two writers produce this row with different key names: the dashboard writes
        // message_limit/time_period, the setup scripts write duplicate_threshold/
        // time_window_seconds. Reading only one spelling silently fell back to the
        // defaults below, which are far tighter than anything a guild configured.
        // How many times the SAME message must be repeated to trigger (default 3)
        const repeatLimit = config.message_limit ?? config.duplicate_threshold ?? 3;
        // Time window in which to count repeated messages (default 30 seconds)
        const timePeriod = (config.time_period ?? config.time_window_seconds ?? 30) * 1000;

        const now = Date.now();

        // Get or create tracking data
        if (!antiSpamCache.has(userKey)) {
            antiSpamCache.set(userKey, { messages: [] });
        }
        const userData = antiSpamCache.get(userKey);

        // Remove messages outside the time window
        userData.messages = userData.messages.filter(msg => now - msg.timestamp < timePeriod);

        // Normalize the current message content for comparison. Uses the
        // forwarded-aware effective content so a forwarded scam link isn't
        // silently exempt from spam detection.
        const normalizedContent = normalizeMessageContent(effectiveContent(message));

        // Skip empty messages (just attachments, embeds, etc.)
        if (!normalizedContent) {
            return;
        }

        // Add current message with content
        userData.messages.push({ content: normalizedContent, timestamp: now });

        // Count how many messages are similar to this one (exact match OR 70%+ similar)
        const similarCount = userData.messages.filter(msg => areMessagesSimilar(msg.content, normalizedContent)).length;

        // Only trigger if similar messages are repeated X times
        if (similarCount >= repeatLimit) {
            logger.info(`[Automod-AntiSpam] Spam detected: ${message.author.tag} sent similar message ${similarCount} times in ${config.time_period || 30}s`, {
                guildId,
                userId: message.author.id,
                channelId: message.channel.id,
                similarCount,
                limit: repeatLimit,
                content: normalizedContent.substring(0, 100) // Log first 100 chars
            });

            // Enter filtered mode and handle the spam
            await enterFilteredMode(message, rule);
            antiSpamCache.delete(userKey); // Reset tracking after entering filtered mode
            return;
        }
    }

    // Fetch and cache heat config for other rules
    let heatConfig = heatConfigCache.get(guildId);
    if (heatConfig === undefined) {
        const [rows] = await pool.execute('SELECT * FROM automod_heat_config WHERE guild_id = ?', [guildId]);
        heatConfig = rows[0] || null;
        heatConfigCache.set(guildId, heatConfig);
    }

    // With heat scoring on, a Delete / Warn / Mute rule adds heat and the heat ladder decides what happens
    // (as before). Kick and Ban rules, and every rule when heat is off, apply their own action. Rules used to
    // do nothing at all without heat, whatever action the dashboard showed.
    const heatOn = !!(heatConfig && heatConfig.is_enabled);
    const heatValues = heatOn ? safeJsonObject(heatConfig.heat_values, 'automod heat_values') : {};

    for (const rule of rules) {
        // Skip antiSpam rules (already handled above)
        if (canonicalFilterType(rule.filter_type) === 'antiSpam') continue;
        if (ruleSkips(rule, message)) continue;

        let violationType = null;
        const config = safeJsonObject(rule.config, 'automod rule config');

        switch (canonicalFilterType(rule.filter_type)) {
            case 'bannedWords': {
                const words = config.words ?? config.banned_words ?? [];
                // `word` matches on word boundaries; `contains` is the old substring behaviour and
                // stays the default so existing rules are untouched.
                //
                // Substring matching is why a filter cannot safely hold a short word: "spic" fires
                // on "spicy", "fag" on "faggot" but also on nothing useful, and a moderation filter
                // that punishes people for the word "class" gets switched off within the hour. The
                // boundary form lets a list contain the short slurs it actually needs to.
                const byWord = (config.match_type ?? 'contains') === 'word';
                const haystack = effectiveContent(message).toLowerCase();
                violationType = words.some((raw) => {
                    const word = String(raw).toLowerCase().trim();
                    if (!word) return false;
                    if (!byWord) return haystack.includes(word);
                    // Escaped, and bounded by anything that is not a letter/digit — so punctuation,
                    // spacing and emoji all count as a boundary, but "damned" does not match "damn".
                    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(haystack);
                }) ? 'bannedWords' : null;
                break;
            }
            case 'discordInvites':
                if (/(discord\.(gg|io|me|li)\/.+|discordapp\.com\/invite\/.+)/i.test(effectiveContent(message))) violationType = 'discordInvites';
                break;
            case 'massMention': {
                const maxMentions = config.max_mentions ?? config.limit ?? 5;
                const maxRoleMentions = config.max_role_mentions ?? Infinity;
                if (message.mentions.users.size >= maxMentions || message.mentions.roles.size >= maxRoleMentions) violationType = 'massMention';
                break;
            }
            case 'allCaps': {
                const content = effectiveContent(message).replace(/<a?:.+?:\d+>|[^a-zA-Z]/g, '');
                const minLength = config.min_length ?? 15;
                const capsPercent = config.caps_percentage ?? config.limit ?? 70;
                if (content.length >= minLength && ((content.match(/[A-Z]/g) || []).length / content.length) * 100 >= capsPercent) violationType = 'allCaps';
                break;
            }
        }

        if (violationType) {
            const handled = await applyRuleAction(message, rule, violationType, heatOn);
            if (heatOn && !handled) {
                const heatToAdd = heatValueFor(heatValues, violationType);
                await addHeat(message, heatToAdd, `Triggered '${violationType}' rule.`);
            }
            return; // Stop processing after one violation
        }
    }
}

/** True when this rule does not apply here: the channel (or its parent) or one of the member's roles is ignored by it. */
function ruleSkips(rule, message) {
    const channels = safeJsonArray(rule.ignored_channels, 'automod ignored_channels').map(String);
    if (channels.length) {
        const ch = message.channel;
        if ([ch?.id, ch?.parentId, ch?.parent?.parentId].some(id => id && channels.includes(id))) return true;
    }
    const roles = safeJsonArray(rule.ignored_roles, 'automod ignored_roles').map(String);
    return roles.length > 0 && !!message.member?.roles?.cache?.some(role => roles.includes(role.id));
}

const RULE_SOURCE = 'Automod rule';
const RULE_ACTIONS = new Set(['delete', 'warn', 'mute', 'kick', 'ban']);
const VIOLATION_LABELS = { bannedWords: 'Banned words', discordInvites: 'Invite links', massMention: 'Mass mentions', allCaps: 'All caps' };
const MAX_RULE_MUTE_MINUTES = 40320; // Discord's 28-day timeout limit

/**
 * A rule's own action (automod_rules.action) on a matching message: the message is deleted, then the
 * sender is warned, muted, kicked or banned as the rule says, with the member DM from the Moderation page.
 * With heat scoring on only Kick and Ban act here; the rest return false so the caller adds heat.
 * @returns {Promise<boolean>} whether the rule's action was applied (or deliberately held back)
 */
async function applyRuleAction(message, rule, violationType, heatOn) {
    const action = RULE_ACTIONS.has(String(rule.action)) ? String(rule.action) : 'delete';
    if (heatOn && action !== 'kick' && action !== 'ban') return false;
    if (!message.guild || !message.member) return true;
    const label = VIOLATION_LABELS[violationType] || violationType;
    const ctx = { member: message.member, channel: message.channel, source: RULE_SOURCE };
    // Unified allowlist / global pause: detected, nothing deleted, nobody punished.
    if (await protectionHold(message.member, 'delete', RULE_SOURCE)) return true;
    await actOrReport(message.guild, 'delete', ctx, () => message.delete());
    if (action === 'delete') {
        await logAutomodAction(message.guild, message.author, 'Delete', `${label} rule: message deleted.`,
            { source: RULE_SOURCE, channel: message.channel }).catch(() => {});
        return true;
    }
    const minutes = Math.min(Math.max(parseInt(rule.action_duration_minutes, 10) || 10, 1), MAX_RULE_MUTE_MINUTES);
    await punishForRule(message, action, `Automod: ${label} rule.`, RULE_SOURCE, minutes);
    return true;
}

/**
 * Warn / mute / kick / ban the sender of a message for an AutoMod rule. Not the bot owner, not while the
 * protections are paused or the member is allowlisted. The DM goes first for kick and ban (afterwards the
 * bot usually shares no server with them). The infraction is only recorded when the action happened.
 * @returns {Promise<boolean>} whether the action was taken
 */
async function punishForRule(message, action, reason, source, minutes = 10) {
    const member = message.member;
    if (!member || isProtectedFromBanCommands(message.author?.id)) return false;
    const doing = action === 'mute' ? 'timeout' : action;
    if (await protectionHold(member, doing, source)) return false;
    const ctx = { member, channel: message.channel, source };
    const automodUser = { tag: 'AutoMod', username: 'AutoMod', id: message.client.user.id, bot: true };
    const stand = { guild: message.guild, client: message.client, user: automodUser };
    const dm = { reason, moderator: automodUser };
    try {
        switch (action) {
            case 'warn':
                if (await logInfraction(stand, message.author, 'Warn', reason)) {
                    await sendModerationDm(message.guild, message.author, 'warn', dm);
                    await logAutomodAction(message.guild, message.author, 'Warn', reason, { source, channel: message.channel });
                    return true;
                }
                return false;
            case 'mute':
                if (await actOrReport(message.guild, 'timeout', ctx, () => member.timeout(minutes * 60 * 1000, reason))) {
                    await logInfraction(stand, message.author, 'Mute', reason, minutes);
                    await sendModerationDm(message.guild, message.author, 'mute', { ...dm, durationMinutes: minutes, expiresAtMs: Date.now() + minutes * 60 * 1000 });
                    await logAutomodAction(message.guild, message.author, 'Mute', reason, { source, channel: message.channel, durationMinutes: minutes });
                    return true;
                }
                return false;
            case 'kick':
            case 'ban': {
                await sendModerationDm(message.guild, message.author, action, action === 'ban' ? { ...dm, permanent: true } : dm);
                const done = await actOrReport(message.guild, action, ctx,
                    () => (action === 'kick' ? member.kick(reason) : member.ban({ reason })));
                if (done) {
                    await logInfraction(stand, message.author, action === 'kick' ? 'Kick' : 'Ban', reason);
                    await logAutomodAction(message.guild, message.author, action === 'kick' ? 'Kick' : 'Ban', reason, { source, channel: message.channel });
                }
                return done;
            }
            default:
                return false;
        }
    } catch (error) {
        logger.error(`[Automod-Rule] Failed to ${action} ${message.author?.tag}`, { guildId: message.guild?.id, error: error.message });
        return false;
    }
}

/**
 * Enter filtered mode for a user who exceeded spam threshold
 * All their messages will be deleted until they stop for 1 minute
 */
async function enterFilteredMode(message, rule) {
    if (!message.guild || !message.member) return;
    // Unified allowlist / global pause: detected (logged above), nothing deleted, no timeout.
    if (await protectionHold(message.member, 'delete', 'Automod spam filter')) return;

    const guildId = message.guild.id;
    const userKey = `${guildId}:${message.author.id}`;
    const now = Date.now();

    // Delete the triggering message and clean up recent spam
    const ctx = { member: message.member, channel: message.channel, source: SPAM_SOURCE };
    await actOrReport(message.guild, 'delete', ctx, () => message.delete());

    try {
        const messages = await message.channel.messages.fetch({ limit: 50 });
        const userMessages = messages.filter(m => m.author.id === message.author.id);
        if (userMessages.size > 0 && message.channel.isTextBased() && 'bulkDelete' in message.channel) {
            await actOrReport(message.guild, 'delete', ctx, () => message.channel.bulkDelete(userMessages));
        }
    } catch (cleanupError) {
        logger.debug(`[Automod-AntiSpam] Could not clean up messages: ${cleanupError.message}`);
    }

    // The rule's chosen action (spamRuleAction). Kick and Ban remove the sender; if the bot cannot, the
    // ladder below still applies. Warn and Mute act now; the burst is still deleted until it stops.
    let action = spamRuleAction(rule);
    if (action === 'kick' || action === 'ban') {
        if (await punishForRule(message, action, 'Automod: Message spam rule.', SPAM_SOURCE)) return;
        action = 'ladder';
    } else if (action === 'warn' || action === 'mute') {
        const minutes = Math.min(Math.max(parseInt(rule?.action_duration_minutes, 10) || 10, 1), MAX_RULE_MUTE_MINUTES);
        await punishForRule(message, action, 'Automod: Message spam rule.', SPAM_SOURCE, minutes);
    } else if (action === 'delete') {
        await logAutomodAction(message.guild, message.author, 'Delete', 'Message spam rule: repeated messages deleted.',
            { source: SPAM_SOURCE, channel: message.channel }).catch(() => {});
    }

    // Set up filtered mode
    const filterData = {
        filteredAt: now,
        lastMessage: now,
        messagesDeleted: 1, // Count the triggering message
        rule: rule,
        action,
        guildId: guildId,
        userId: message.author.id,
        userTag: message.author.tag,
        channelId: message.channel.id,
        releaseTimer: null
    };

    // Set the release timer for 1 minute from now
    filterData.releaseTimer = setTimeout(() => {
        releaseFilteredUser(userKey, message.client);
    }, FILTER_COOLDOWN_MS);

    filteredUsers.set(userKey, filterData);

    logger.info(`[Automod-AntiSpam] User ${message.author.tag} entered filtered mode`, {
        guildId,
        userId: message.author.id,
        channelId: message.channel.id
    });
}

/**
 * Release a user from filtered mode after cooldown
 * Log infraction and apply escalating timeout
 */
async function releaseFilteredUser(userKey, client) {
    const filterData = filteredUsers.get(userKey);
    if (!filterData) return;

    filteredUsers.delete(userKey);

    const { guildId, userId, userTag, messagesDeleted, channelId } = filterData;

    // Only the ladder acts on release; the other actions were applied when the spam was caught.
    if (filterData.action && filterData.action !== 'ladder') {
        logger.info(`[Automod-AntiSpam] Released ${userTag} from filtered mode (${messagesDeleted} message(s) deleted, action: ${filterData.action})`, { guildId, userId });
        return;
    }

    logger.info(`[Automod-AntiSpam] Releasing ${userTag} from filtered mode after 1 minute cooldown`, {
        guildId,
        userId,
        messagesDeleted
    });

    try {
        // Get violation count for this user in the last 24 hours
        const [violations] = await pool.execute(
            `SELECT COUNT(*) as count FROM infractions
             WHERE guild_id = ? AND user_id = ? AND type = 'AntiSpam'
             AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
            [guildId, userId]
        );
        const violationCount = violations[0]?.count || 0;

        // Determine timeout duration based on violation count
        const timeoutMinutes = spamLadderMinutes(violationCount);

        // Paused (or exempt since filtering began): no infraction, no timeout.
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
        if (member && await protectionHold(member, 'timeout', 'Automod spam filter')) return;

        // Log infraction to database
        await pool.execute(
            `INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes)
             VALUES (?, ?, ?, 'AntiSpam', ?, ?)`,
            [guildId, userId, client.user.id,
             `Spam filter triggered: ${messagesDeleted} messages deleted. Violation #${violationCount + 1} in 24h.`,
             timeoutMinutes]
        );

        // Apply timeout (when the bot cannot, "Manual action needed" says why and nothing claims it happened)
        if (guild) {
            const timeoutMs = timeoutMinutes * 60 * 1000;
            if (member && await actOrReport(guild, 'timeout', { member, source: SPAM_SOURCE },
                () => member.timeout(timeoutMs, `Automod: Spam filter - ${messagesDeleted} messages deleted. Violation #${violationCount + 1}`))) {

                logger.info(`[Automod-AntiSpam] Applied ${timeoutMinutes} minute timeout to ${userTag} (violation #${violationCount + 1})`, {
                    guildId,
                    userId,
                    timeoutMinutes,
                    violationCount: violationCount + 1
                });

                // Notify user in channel
                const channel = await guild.channels.fetch(channelId).catch(() => null);

                // Post to the guild's log channel — the infraction row above is invisible
                // to moderators on its own.
                await logAutomodAction(guild, member.user, 'Mute',
                    `Spam filter: ${messagesDeleted} message(s) deleted. Violation #${violationCount + 1} in 24h.`,
                    { durationMinutes: timeoutMinutes, source: 'Anti-Spam Filter', channel }
                ).catch(err => logger.warn('[Automod-AntiSpam] Failed to post automod log', { error: err.message, guildId }));
                if (channel && channel.isTextBased()) {
                    const notifyMsg = await channel.send(
                        `⚠️ <@${userId}> has been timed out for **${timeoutMinutes} minute${timeoutMinutes > 1 ? 's' : ''}** for spamming. ` +
                        `(${messagesDeleted} messages deleted, violation #${violationCount + 1} in 24h)`
                    ).catch(() => null);

                    // Delete notification after 10 seconds
                    if (notifyMsg) {
                        setTimeout(() => notifyMsg.delete().catch(() => {}), 10000);
                    }
                }
            }
        }

    } catch (error) {
        logger.error(`[Automod-AntiSpam] Error releasing filtered user ${userTag}:`, {
            error: error instanceof Error ? error.stack : error,
            guildId,
            userId
        });
    }
}

/**
 * Check if a user is currently filtered (exported for external use)
 */
export function isUserFiltered(guildId, userId) {
    return filteredUsers.has(`${guildId}:${userId}`);
}

/**
 * Get filtered user stats (exported for external use)
 */
export function getFilteredUserStats(guildId, userId) {
    const data = filteredUsers.get(`${guildId}:${userId}`);
    if (!data) return null;
    return {
        filteredAt: data.filteredAt,
        lastMessage: data.lastMessage,
        messagesDeleted: data.messagesDeleted,
        timeInFilterMs: Date.now() - data.filteredAt
    };
}

async function addHeat(message, heat, reason) {
    if (!message.guild) return;

    const guildId = message.guild.id;
    const userKey = `${guildId}:${message.author.id}`;

    const heatConfig = heatConfigCache.get(guildId);
    if (!heatConfig) return;

    const decayMinutes = heatConfig.decay_minutes || 10;
    const now = Date.now();
    const decayTime = decayMinutes * 60 * 1000;

    let userData = heatCache.get(userKey) || { score: 0, infractions: [] };

    // Decay old infractions
    userData.infractions = userData.infractions.filter(inf => now - inf.timestamp < decayTime);
    userData.score = userData.infractions.reduce((sum, inf) => sum + inf.heat, 0);

    // Add new heat
    userData.infractions.push({ timestamp: now, heat });
    userData.score += heat;

    heatCache.set(userKey, userData);
    logger.info(`Added ${heat} heat to ${message.author.tag}. New score: ${userData.score}. Reason: ${reason}`, { guildId, category: 'automod-heat' });

    // Check for action thresholds
    const actionThresholds = parseActionThresholds(heatConfig.action_thresholds);

    for (const action of actionThresholds) {
        if (userData.score >= action.threshold) {
            logger.warn(`${message.author.tag} crossed heat threshold of ${action.threshold}. Taking action: ${action.type}`, { guildId, category: 'automod-heat' });
            await takeHeatAction(message, action);
            heatCache.delete(userKey); // Reset heat after action
            return;
        }
    }
}

async function takeHeatAction(message, action) {
    if (!message.guild || !message.member) return;
    if (isProtectedFromBanCommands(message.author?.id)) return;
    // Unified allowlist / global pause: no warning, timeout, kick, ban or clean-up.
    const doing = action.type === 'mute' ? 'timeout' : ['warn', 'kick', 'ban'].includes(action.type) ? action.type : 'delete';
    if (await protectionHold(message.member, doing, 'Automod heat')) return;

    const reason = `Automod: Reached heat threshold of ${action.threshold}.`;
    try {
        // Create a mock interaction object for logInfraction compatibility
        const mockInteraction = {
            guild: message.guild,
            user: { tag: 'Automod', id: message.client.user.id }
        };

        // The infraction is only recorded when the action really happened; when the bot cannot act,
        // actOrReport has raised "Manual action needed" and the clean-up below still runs.
        const member = message.member;
        const ctx = { member, channel: message.channel, source: HEAT_SOURCE };
        switch (action.type) {
            case 'warn':
                // Using logInfraction will DM the user and log it.
                await logInfraction(mockInteraction, message.author, 'Warn', reason);
                break;
            case 'mute':
                if (await actOrReport(message.guild, 'timeout', ctx, () => member.timeout((action.duration || 10) * 60 * 1000, reason))) {
                    await logInfraction(mockInteraction, message.author, 'Mute', reason, action.duration);
                }
                break;
            case 'kick':
                if (await actOrReport(message.guild, 'kick', ctx, () => member.kick(reason))) {
                    await logInfraction(mockInteraction, message.author, 'Kick', reason);
                }
                break;
            case 'ban':
                if (await actOrReport(message.guild, 'ban', ctx, () => member.ban({ reason }))) {
                    await logInfraction(mockInteraction, message.author, 'Ban', reason);
                }
                break;
        }
        // Clean up the messages that contributed to the heat. A warning is the mildest
        // rung on the ladder — wiping 20 of the member's recent messages for it is
        // punishment out of all proportion, so only the triggering message goes.
        if (action.type === 'warn') {
            await actOrReport(message.guild, 'delete', ctx, () => message.delete());
        } else {
            const messages = await message.channel.messages.fetch({ limit: 20 });
            const userMessages = messages.filter(m => m.author.id === message.author.id);
            if (message.channel.isTextBased() && 'bulkDelete' in message.channel) {
                await actOrReport(message.guild, 'delete', ctx, () => message.channel.bulkDelete(userMessages));
            }
        }

    } catch (error) {
        logger.error(`[Automod-Heat] Failed to take action '${action.type}' on ${message.author.tag}:`, { error: error instanceof Error ? error.stack : error });
    }
}
