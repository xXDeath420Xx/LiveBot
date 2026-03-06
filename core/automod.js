import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logInfraction } from './moderation-manager.js';
import { safeJsonArray, safeJsonObject } from '../utils/safeJson.js';

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

    return content
        .toLowerCase()
        .trim()
        // Collapse multiple spaces/newlines to single space
        .replace(/\s+/g, ' ')
        // Remove zero-width characters often used to bypass spam detection
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        // Normalize unicode characters (é -> e, etc.)
        .normalize('NFKC');
}

/**
 * Check if two messages are similar enough to be considered the same spam
 * Returns true if messages are 80%+ similar
 */
function areMessagesSimilar(msg1, msg2) {
    if (msg1 === msg2) return true;
    if (!msg1 || !msg2) return false;

    // For very short messages (under 8 chars), require exact match
    // This prevents "ok" "lol" "yes" "no" etc from matching each other
    if (msg1.length < 8 || msg2.length < 8) {
        return msg1 === msg2;
    }

    const shorter = msg1.length <= msg2.length ? msg1 : msg2;
    const longer = msg1.length > msg2.length ? msg1 : msg2;

    // Repetition spam check: if shorter is contained in longer AND
    // the shorter is at least 50% of the longer's length, it's likely spam
    // This catches "😂😂😂" vs "😂😂😂😂😂" but not "lol" vs "lol I'm dying"
    if (longer.includes(shorter) && shorter.length >= longer.length * 0.5) {
        return true;
    }

    // Calculate similarity using Sørensen–Dice coefficient on character bigrams
    const getBigrams = (str) => {
        const bigrams = new Set();
        for (let i = 0; i < str.length - 1; i++) {
            bigrams.add(str.substring(i, i + 2));
        }
        return bigrams;
    };

    const bigrams1 = getBigrams(msg1);
    const bigrams2 = getBigrams(msg2);

    let intersection = 0;
    for (const bigram of bigrams1) {
        if (bigrams2.has(bigram)) intersection++;
    }

    const similarity = (2 * intersection) / (bigrams1.size + bigrams2.size);

    // 80% similarity threshold - stricter to avoid false positives
    return similarity >= 0.8;
}

export async function processMessage(message) {
    if (!message.guild || message.author.bot || !message.member) return;

    // Skip automod for users with Administrator permission or guild owners
    const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
    const isOwner = message.member.id === message.guild.ownerId;
    if (isAdmin || isOwner) return;

    const guildId = message.guild.id;
    const userKey = `${guildId}:${message.author.id}`;

    // Check if user is currently in filtered mode
    if (filteredUsers.has(userKey)) {
        const filterData = filteredUsers.get(userKey);
        const now = Date.now();

        // Delete the message immediately
        await message.delete().catch(() => {});
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

    // Check for ignored roles
    const ignoredRoles = rules.flatMap(r => safeJsonArray(r.ignored_roles, 'automod ignored_roles'));
    if (message.member.roles.cache.some(role => ignoredRoles.includes(role.id))) return;

    // First, check antiSpam rules (these work independently of heat config)
    for (const rule of rules) {
        if (rule.filter_type !== 'anti_spam' && rule.filter_type !== 'antiSpam') continue;

        const ruleIgnoredChannels = safeJsonArray(rule.ignored_channels, 'automod ignored_channels');
        if (ruleIgnoredChannels.includes(message.channel.id)) continue;

        const config = safeJsonObject(rule.config, 'automod rule config');
        // How many times the SAME message must be repeated to trigger (default 3)
        const repeatLimit = config.message_limit || 3;
        // Time window in which to count repeated messages (default 30 seconds)
        const timePeriod = (config.time_period || 30) * 1000;

        const now = Date.now();

        // Get or create tracking data
        if (!antiSpamCache.has(userKey)) {
            antiSpamCache.set(userKey, { messages: [] });
        }
        const userData = antiSpamCache.get(userKey);

        // Remove messages outside the time window
        userData.messages = userData.messages.filter(msg => now - msg.timestamp < timePeriod);

        // Normalize the current message content for comparison
        // Remove extra whitespace, convert to lowercase, strip emoji variations
        const normalizedContent = normalizeMessageContent(message.content);

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

    // If heat system is disabled, skip heat-based rules
    if (!heatConfig || !heatConfig.is_enabled) return;

    const heatValues = safeJsonObject(heatConfig.heat_values, 'automod heat_values');

    for (const rule of rules) {
        // Skip antiSpam rules (already handled above)
        if (rule.filter_type === 'anti_spam' || rule.filter_type === 'antiSpam') continue;

        const ruleIgnoredChannels = safeJsonArray(rule.ignored_channels, 'automod ignored_channels');
        if (ruleIgnoredChannels.includes(message.channel.id)) continue;

        let violationType = null;
        const config = safeJsonObject(rule.config, 'automod rule config');

        switch (rule.filter_type) {
            case 'bannedWords':
                if ((config.banned_words || []).some((word) => message.content.toLowerCase().includes(word.toLowerCase()))) violationType = 'bannedWords';
                break;
            case 'discordInvites':
                if (/(discord\.(gg|io|me|li)\/.+|discordapp\.com\/invite\/.+)/i.test(message.content)) violationType = 'discordInvites';
                break;
            case 'massMention':
                if (message.mentions.users.size >= (config.limit || 5)) violationType = 'massMention';
                break;
            case 'allCaps':
                const content = message.content.replace(/<a?:.+?:\d+>|[^a-zA-Z]/g, '');
                if (content.length >= 15 && ((content.match(/[A-Z]/g) || []).length / content.length) * 100 >= (config.limit || 70)) violationType = 'allCaps';
                break;
        }

        if (violationType) {
            const heatToAdd = heatValues[violationType] || 1;
            await addHeat(message, heatToAdd, `Triggered '${violationType}' rule.`);
            return; // Stop processing after one violation
        }
    }
}

/**
 * Enter filtered mode for a user who exceeded spam threshold
 * All their messages will be deleted until they stop for 1 minute
 */
async function enterFilteredMode(message, rule) {
    if (!message.guild || !message.member) return;

    const guildId = message.guild.id;
    const userKey = `${guildId}:${message.author.id}`;
    const now = Date.now();

    // Delete the triggering message and clean up recent spam
    await message.delete().catch(() => {});

    try {
        const messages = await message.channel.messages.fetch({ limit: 50 });
        const userMessages = messages.filter(m => m.author.id === message.author.id);
        if (userMessages.size > 0 && message.channel.isTextBased() && 'bulkDelete' in message.channel) {
            await message.channel.bulkDelete(userMessages).catch(() => {});
        }
    } catch (cleanupError) {
        logger.debug(`[Automod-AntiSpam] Could not clean up messages: ${cleanupError.message}`);
    }

    // Set up filtered mode
    const filterData = {
        filteredAt: now,
        lastMessage: now,
        messagesDeleted: 1, // Count the triggering message
        rule: rule,
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
        const timeoutIndex = Math.min(violationCount, ESCALATING_TIMEOUTS.length - 1);
        const timeoutMinutes = ESCALATING_TIMEOUTS[timeoutIndex];

        // Log infraction to database
        await pool.execute(
            `INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes)
             VALUES (?, ?, ?, 'AntiSpam', ?, ?)`,
            [guildId, userId, client.user.id,
             `Spam filter triggered: ${messagesDeleted} messages deleted. Violation #${violationCount + 1} in 24h.`,
             timeoutMinutes]
        );

        // Apply timeout
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (guild) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member && member.moderatable) {
                const timeoutMs = timeoutMinutes * 60 * 1000;
                await member.timeout(timeoutMs, `Automod: Spam filter - ${messagesDeleted} messages deleted. Violation #${violationCount + 1}`);

                logger.info(`[Automod-AntiSpam] Applied ${timeoutMinutes} minute timeout to ${userTag} (violation #${violationCount + 1})`, {
                    guildId,
                    userId,
                    timeoutMinutes,
                    violationCount: violationCount + 1
                });

                // Notify user in channel
                const channel = await guild.channels.fetch(channelId).catch(() => null);
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
    const actionThresholds = safeJsonArray(heatConfig.action_thresholds, 'automod action_thresholds').sort((a, b) => b.threshold - a.threshold);

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

    const reason = `Automod: Reached heat threshold of ${action.threshold}.`;
    try {
        // Create a mock interaction object for logInfraction compatibility
        const mockInteraction = {
            guild: message.guild,
            user: { tag: 'Automod', id: message.client.user.id }
        };

        switch (action.type) {
            case 'warn':
                // Using logInfraction will DM the user and log it.
                await logInfraction(mockInteraction, message.author, 'Warn', reason);
                break;
            case 'mute':
                if (message.member.moderatable) {
                    await message.member.timeout((action.duration || 10) * 60 * 1000, reason);
                    await logInfraction(mockInteraction, message.author, 'Mute', reason, action.duration);
                }
                break;
            case 'kick':
                if (message.member.kickable) {
                    await message.member.kick(reason);
                    await logInfraction(mockInteraction, message.author, 'Kick', reason);
                }
                break;
            case 'ban':
                if (message.member.bannable) {
                    await message.member.ban({ reason });
                    await logInfraction(mockInteraction, message.author, 'Ban', reason);
                }
                break;
        }
        // Clean up user's recent messages that contributed to the heat
        const messages = await message.channel.messages.fetch({ limit: 20 });
        const userMessages = messages.filter(m => m.author.id === message.author.id);
        if (message.channel.isTextBased() && 'bulkDelete' in message.channel) {
            await message.channel.bulkDelete(userMessages).catch(() => {});
        }

    } catch (error) {
        logger.error(`[Automod-Heat] Failed to take action '${action.type}' on ${message.author.tag}:`, { error: error instanceof Error ? error.stack : error });
    }
}
