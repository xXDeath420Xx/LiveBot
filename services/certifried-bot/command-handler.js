/**
 * Command Handler for CertiFriedUtility Bot
 * Processes incoming messages and routes to appropriate commands
 */

import logger from '../../utils/logger.js';
import pool from '../../utils/db.js';
import { getCommand, incrementCustomCommandUse } from './command-registry.js';
import { processTemplate } from './template-processor.js';
import { runAutoResponders } from './auto-responder.js';
import { runKickAutomod } from './kick-automod.js';
import { resolveChannel } from './defender/channel-tokens.js';
import { deleteMessage as kickDeleteMessage } from './defender/kick-moderation.js';
import { enforcer } from './defender/index.js';
import { resolveDefenderCommand, meetsMinRole, resolvePermissionContext } from './defender/commands/index.js';

// Cooldown tracking: Map<channelId-commandKey-userId, timestamp>
const userCooldowns = new Map();
const globalCooldowns = new Map();

/**
 * Get channel configuration from database
 */
async function getChannelConfig(platform, channelId) {
    try {
        const [rows] = await pool.execute(
            `SELECT * FROM tokes_channels
             WHERE platform = ? AND channel_id = ? AND is_enabled = 1`,
            [platform, channelId]
        );
        return rows[0] || null;
    } catch (error) {
        logger.error('[CommandHandler] Failed to get channel config', { error: error.message });
        return null;
    }
}

/**
 * Check if user is on cooldown for a specific command
 */
function isOnCooldown(channelId, commandKey, userId, commandCooldown) {
    const now = Date.now();
    const cooldownMs = commandCooldown * 1000;

    // Check user cooldown for this specific command
    const userKey = `${channelId}-${commandKey}-${userId}`;
    const lastUser = userCooldowns.get(userKey) || 0;
    if (now - lastUser < cooldownMs) {
        return true;
    }

    return false;
}

/**
 * Set cooldowns after command execution
 */
function setCooldowns(channelId, commandKey, userId) {
    const now = Date.now();
    userCooldowns.set(`${channelId}-${commandKey}-${userId}`, now);
}

/**
 * Get or create user profile
 */
async function getOrCreateProfile(platform, userId, displayName) {
    try {
        // Try to get existing profile
        let [rows] = await pool.execute(
            `SELECT * FROM tokes_profiles
             WHERE platform = ? AND platform_user_id = ?`,
            [platform, userId]
        );

        if (rows.length > 0) {
            // Update display name if changed
            if (rows[0].display_name !== displayName) {
                await pool.execute(
                    `UPDATE tokes_profiles SET display_name = ?, last_active = NOW()
                     WHERE id = ?`,
                    [displayName, rows[0].id]
                );
                rows[0].display_name = displayName;
            }
            return rows[0];
        }

        // Create new profile (marked as claimed since they're actively using the bot)
        const [result] = await pool.execute(
            `INSERT INTO tokes_profiles (platform, platform_user_id, display_name, is_claimed, last_active)
             VALUES (?, ?, ?, 1, NOW())`,
            [platform, userId, displayName]
        );

        return {
            id: result.insertId,
            platform,
            platform_user_id: userId,
            display_name: displayName,
            lifetime_tokes: 0,
            today_tokes: 0,
            current_streak: 0,
            best_streak: 0,
            xp: 0,
            level: 1,
            is_claimed: 1
        };

    } catch (error) {
        logger.error('[CommandHandler] Failed to get/create profile', { error: error.message });
        return null;
    }
}

/**
 * Get or create channel stats for user
 */
async function getOrCreateChannelStats(channelDbId, userId, displayName) {
    try {
        let [rows] = await pool.execute(
            `SELECT * FROM tokes_channel_stats
             WHERE channel_id = ? AND platform_user_id = ?`,
            [channelDbId, userId]
        );

        if (rows.length > 0) {
            return rows[0];
        }

        // Create new channel stats
        const [result] = await pool.execute(
            `INSERT INTO tokes_channel_stats (channel_id, platform_user_id, display_name, last_active)
             VALUES (?, ?, ?, NOW())`,
            [channelDbId, userId, displayName]
        );

        return {
            id: result.insertId,
            channel_id: channelDbId,
            platform_user_id: userId,
            display_name: displayName,
            tokes: 0,
            sessions_joined: 0,
            trivia_wins: 0
        };

    } catch (error) {
        logger.error('[CommandHandler] Failed to get/create channel stats', { error: error.message });
        return null;
    }
}

/**
 * Process an incoming message
 */
export async function handleMessage(context) {
    const {
        platform,        // 'twitch' or 'kick'
        channelId,       // Platform channel ID
        channelName,     // Channel display name
        userId,          // Platform user ID
        username,        // User display name
        message,         // Raw message text
        messageId,       // Platform message id (Kick chat message UUID; for delete fallback)
        isBroadcaster,   // Is user the channel owner
        isMod,           // Is user a moderator
        reply           // Function to send reply: (text) => void
    } = context;

    // Kick Defender: ban-on-event. Runs BEFORE channel-config / prefix checks so
    // banlisted users are handled even when they aren't issuing a command and even
    // in channels with no games config. No-ops for non-kick / non-enrolled channels.
    try {
        const result = await enforcer.check({ platform, channelId, userId, username, messageId, content: message, isMod, isBroadcaster, reply });
        if (result.acted) return; // user was banned / message deleted; stop processing
    } catch (err) {
        // Never let defender errors break normal chat handling.
        logger.error('[KBD] enforcer.check failed', { error: err.message });
    }

    // Get channel config
    const channel = await getChannelConfig(platform, channelId);
    if (!channel) {
        return; // Channel not registered or disabled
    }

    // Content automod (Kick): caps/links/symbols/length filters from the
    // channel's features_enabled.automod settings. Runs on EVERY message (incl.
    // commands) so a spammy command line is also caught. Deletes via the owner's
    // token. No-op unless the channel has automod rules enabled.
    if (platform === 'kick') {
        const actioned = await runKickAutomod({
            channelPk: channel.id, messageId, message, username, isMod, isBroadcaster, reply,
            deleteMessage: async (msgId) => {
                const ch = await resolveChannel(channelId);
                if (ch?.token) await kickDeleteMessage(msgId, ch.token);
            }
        });
        if (actioned) return; // message removed; stop processing
    }

    const prefix = channel.command_prefix || '!';

    // Check if message starts with prefix
    if (!message.startsWith(prefix)) {
        // Not a command — give keyword auto-responders a chance to reply.
        await runAutoResponders(
            { channelPk: channel.id, channelName, username, message, reply },
            processTemplate
        );
        return;
    }

    // Parse command and args
    const withoutPrefix = message.slice(prefix.length);
    const parts = withoutPrefix.split(/\s+/);
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Defender commands: self-contained in-memory dispatch with manager/admin
    // tiers, BEFORE the DB-backed registry. Returns when handled.
    const defCmd = resolveDefenderCommand(commandName);
    if (defCmd) {
        const permCtx = await resolvePermissionContext({ platform, userId, isBroadcaster });
        if (!meetsMinRole(defCmd.minRole, permCtx)) {
            return; // silently ignore unauthorized defender command
        }
        const defCtx = { platform, channelId, channelName, userId, username, args, message, reply, isBroadcaster, isMod, permCtx };
        try {
            await defCmd.handler(defCtx);
        } catch (err) {
            logger.error('[KBD] defender command failed', { command: commandName, error: err.message });
        }
        return; // handled; do not fall through to games/custom commands
    }

    // Get command from registry (handles global config, channel overrides, and custom commands)
    const command = await getCommand(channel.id, commandName);
    if (!command) {
        return; // Command not found or disabled
    }

    // Check permission requirements
    if (command.broadcasterOnly && !isBroadcaster) {
        return; // Broadcaster only command
    }
    if (command.modOnly && !isBroadcaster && !isMod) {
        return; // Mod only command
    }

    // Check cooldowns (bypass for mods/broadcasters)
    if (!isBroadcaster && !isMod) {
        if (isOnCooldown(channel.id, command.key, userId, command.cooldown)) {
            return; // Silently ignore cooldown
        }
    }

    // Get/create user profile and channel stats
    const profile = await getOrCreateProfile(platform, userId, username);
    const channelStats = await getOrCreateChannelStats(channel.id, userId, username);

    if (!profile || !channelStats) {
        return;
    }

    // Build command context
    const cmdContext = {
        platform,
        channel,
        channelId,
        channelName,
        userId,
        username,
        profile,
        channelStats,
        args,
        rawMessage: message,
        isBroadcaster,
        isMod,
        reply,
        commandName,
        commandConfig: command
    };

    try {
        if (command.isCustom) {
            // Handle custom command - just process template and reply
            const response = processTemplate(command.response, cmdContext);
            await reply(response);

            // Increment use count
            await incrementCustomCommandUse(command.customId);
        } else if (command.handler) {
            // Execute built-in command handler
            await command.handler(cmdContext);
        }

        // Set cooldowns after successful command
        if (!isBroadcaster && !isMod) {
            setCooldowns(channel.id, command.key, userId);
        }

        // Log command usage
        await pool.execute(
            `INSERT INTO tokes_activity_log (channel_id, platform, event_type, actor, details)
             VALUES (?, ?, 'command', ?, ?)`,
            [channel.id, platform, username, `!${commandName} ${args.join(' ')}`.trim()]
        );

    } catch (error) {
        logger.error('[CommandHandler] Command execution failed', {
            command: commandName,
            error: error.message
        });
    }
}

export { getOrCreateProfile, getOrCreateChannelStats };
