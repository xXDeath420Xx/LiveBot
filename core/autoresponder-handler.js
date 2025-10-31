/**
 * Auto-Responder Handler
 * Checks messages against configured auto-responders and triggers responses
 */

const { db } = require('../utils/db');
const { logger } = require('../utils/logger');

// Cache for autoresponders (refresh every 5 minutes)
let autoresponderCache = new Map();
let lastCacheRefresh = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load autoresponders for a guild into cache
 */
async function loadAutoresponders(guildId) {
    try {
        const [responders] = await db.execute(
            'SELECT * FROM autoresponders WHERE guild_id = ? AND enabled = TRUE',
            [guildId]
        );

        autoresponderCache.set(guildId, responders);
        logger.info(`[AutoResponder] Loaded ${responders.length} active autoresponders for guild ${guildId}`);
    } catch (error) {
        logger.error(`[AutoResponder] Failed to load autoresponders for guild ${guildId}:`, error);
    }
}

/**
 * Refresh cache if needed
 */
async function refreshCacheIfNeeded(guildId) {
    const now = Date.now();
    if (now - lastCacheRefresh > CACHE_TTL || !autoresponderCache.has(guildId)) {
        await loadAutoresponders(guildId);
        lastCacheRefresh = now;
    }
}

/**
 * Check if message matches a trigger
 */
function matchesTrigger(message, trigger, matchType, caseSensitive) {
    let messageText = message.content;
    let triggerText = trigger;

    if (!caseSensitive) {
        messageText = messageText.toLowerCase();
        triggerText = triggerText.toLowerCase();
    }

    switch (matchType) {
        case 'exact':
            return messageText === triggerText;

        case 'contains':
            return messageText.includes(triggerText);

        case 'starts_with':
            return messageText.startsWith(triggerText);

        case 'ends_with':
            return messageText.endsWith(triggerText);

        case 'wildcard':
            // Convert wildcard pattern to regex
            const wildcardRegex = new RegExp(
                '^' + triggerText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$',
                caseSensitive ? '' : 'i'
            );
            return wildcardRegex.test(message.content);

        case 'regex':
            try {
                const regex = new RegExp(triggerText, caseSensitive ? '' : 'i');
                return regex.test(message.content);
            } catch (e) {
                logger.warn(`[AutoResponder] Invalid regex: ${triggerText}`, e);
                return false;
            }

        default:
            return false;
    }
}

/**
 * Check if user/channel passes restrictions
 */
function passesRestrictions(message, responder) {
    // Check channel restrictions
    if (responder.allowed_channels) {
        try {
            const allowedChannels = JSON.parse(responder.allowed_channels);
            if (allowedChannels.length > 0 && !allowedChannels.includes(message.channel.id)) {
                return false;
            }
        } catch (e) {
            logger.warn('[AutoResponder] Failed to parse allowed_channels:', e);
        }
    }

    if (responder.blocked_channels) {
        try {
            const blockedChannels = JSON.parse(responder.blocked_channels);
            if (blockedChannels.includes(message.channel.id)) {
                return false;
            }
        } catch (e) {
            logger.warn('[AutoResponder] Failed to parse blocked_channels:', e);
        }
    }

    // Check role restrictions
    const memberRoles = message.member?.roles?.cache?.map(r => r.id) || [];

    if (responder.allowed_roles) {
        try {
            const allowedRoles = JSON.parse(responder.allowed_roles);
            if (allowedRoles.length > 0) {
                if (responder.require_all_roles) {
                    // User must have ALL allowed roles
                    if (!allowedRoles.every(roleId => memberRoles.includes(roleId))) {
                        return false;
                    }
                } else {
                    // User must have AT LEAST ONE allowed role
                    if (!allowedRoles.some(roleId => memberRoles.includes(roleId))) {
                        return false;
                    }
                }
            }
        } catch (e) {
            logger.warn('[AutoResponder] Failed to parse allowed_roles:', e);
        }
    }

    if (responder.blocked_roles) {
        try {
            const blockedRoles = JSON.parse(responder.blocked_roles);
            if (blockedRoles.some(roleId => memberRoles.includes(roleId))) {
                return false;
            }
        } catch (e) {
            logger.warn('[AutoResponder] Failed to parse blocked_roles:', e);
        }
    }

    return true;
}

/**
 * Check if autoresponder is on cooldown
 */
async function isOnCooldown(responderId, userId, channelId, cooldownSeconds, cooldownPerUser, cooldownPerChannel) {
    if (cooldownSeconds === 0) {
        return false;
    }

    try {
        let query = 'SELECT triggered_at FROM autoresponder_cooldowns WHERE autoresponder_id = ?';
        const params = [responderId];

        if (cooldownPerUser) {
            query += ' AND user_id = ?';
            params.push(userId);
        }

        if (cooldownPerChannel) {
            query += ' AND channel_id = ?';
            params.push(channelId);
        }

        query += ' ORDER BY triggered_at DESC LIMIT 1';

        const [cooldowns] = await db.execute(query, params);

        if (cooldowns.length > 0) {
            const lastTrigger = new Date(cooldowns[0].triggered_at);
            const now = new Date();
            const secondsSince = (now - lastTrigger) / 1000;

            if (secondsSince < cooldownSeconds) {
                return true;
            }
        }

        return false;
    } catch (error) {
        logger.error('[AutoResponder] Failed to check cooldown:', error);
        return false; // Allow on error
    }
}

/**
 * Record trigger and update stats
 */
async function recordTrigger(responderId, userId, channelId) {
    try {
        // Record cooldown
        await db.execute(
            'INSERT INTO autoresponder_cooldowns (autoresponder_id, user_id, channel_id) VALUES (?, ?, ?)',
            [responderId, userId, channelId]
        );

        // Update stats
        await db.execute(
            'UPDATE autoresponders SET use_count = use_count + 1, last_triggered = NOW() WHERE id = ?',
            [responderId]
        );

        // Clean up old cooldown records (older than 1 hour)
        await db.execute(
            'DELETE FROM autoresponder_cooldowns WHERE triggered_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)'
        );
    } catch (error) {
        logger.error('[AutoResponder] Failed to record trigger:', error);
    }
}

/**
 * Main handler for incoming messages
 */
async function handleMessage(message) {
    // Ignore bots
    if (message.author.bot) return;

    // Ignore DMs
    if (!message.guild) return;

    // Ignore empty messages
    if (!message.content || message.content.trim().length === 0) return;

    try {
        // Refresh cache if needed
        await refreshCacheIfNeeded(message.guild.id);

        const responders = autoresponderCache.get(message.guild.id) || [];

        if (responders.length === 0) return;

        // Check each autoresponder
        for (const responder of responders) {
            // Check if message matches trigger
            if (!matchesTrigger(message, responder.trigger_text, responder.match_type, responder.case_sensitive)) {
                continue;
            }

            // Check restrictions
            if (!passesRestrictions(message, responder)) {
                continue;
            }

            // Check cooldown
            if (await isOnCooldown(
                responder.id,
                message.author.id,
                message.channel.id,
                responder.cooldown_seconds,
                responder.cooldown_per_user,
                responder.cooldown_per_channel
            )) {
                continue;
            }

            // Trigger response
            try {
                // Delete trigger message if configured
                if (responder.delete_trigger && message.deletable) {
                    await message.delete().catch(() => {});
                }

                // Send response based on type
                if (responder.response_type === 'react') {
                    // Add reactions
                    const reactions = responder.reactions ? responder.reactions.split(',') : [];
                    for (const emoji of reactions) {
                        await message.react(emoji.trim()).catch(() => {});
                    }
                } else if (responder.response_type === 'embed' && responder.embed_json) {
                    // Send embed
                    try {
                        const embedData = JSON.parse(responder.embed_json);
                        await message.channel.send({ embeds: [embedData] });
                    } catch (e) {
                        // Fallback to text if embed fails
                        await message.channel.send(responder.response_text);
                    }
                } else {
                    // Send text response
                    const sendOptions = { content: responder.response_text };

                    if (responder.reply_to_user) {
                        sendOptions.reply = { messageReference: message.id };
                    }

                    await message.channel.send(sendOptions);
                }

                // Record trigger
                await recordTrigger(responder.id, message.author.id, message.channel.id);

                logger.info(`[AutoResponder] Triggered #${responder.id} in guild ${message.guild.id} by user ${message.author.id}`);

            } catch (error) {
                logger.error(`[AutoResponder] Failed to send response for #${responder.id}:`, error);
            }

            // Only trigger first matching autoresponder
            break;
        }
    } catch (error) {
        logger.error('[AutoResponder] Handler error:', error);
    }
}

/**
 * Invalidate cache for a guild (call after creating/editing/deleting autoresponders)
 */
async function invalidateCache(guildId) {
    autoresponderCache.delete(guildId);
    await loadAutoresponders(guildId);
}

module.exports = {
    handleMessage,
    invalidateCache,
    loadAutoresponders
};
