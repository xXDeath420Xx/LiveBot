import { queryWithRetry } from './db.js';
import pool from './db.js';
import logger from './logger.js';
import { ChannelType } from 'discord.js';

/**
 * Save a message to the database for later retrieval on deletion.
 * Fire-and-forget — never throws.
 */
export async function saveMessage(message) {
    try {
        if (!message.guild) return;

        const attachmentUrls = message.attachments.size > 0
            ? JSON.stringify([...message.attachments.values()].map(a => a.url))
            : null;

        await queryWithRetry(
            `INSERT INTO message_logs (message_id, guild_id, channel_id, author_id, author_tag, content, attachment_urls)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE content = VALUES(content), attachment_urls = VALUES(attachment_urls)`,
            [
                message.id,
                message.guild.id,
                message.channel.id,
                message.author.id,
                message.author.tag || message.author.username,
                message.content || null,
                attachmentUrls
            ]
        );
    } catch (error) {
        logger.error('[MessageCache] Failed to save message', {
            messageId: message.id,
            error: error.message
        });
    }
}

/**
 * Update stored message content after an edit.
 * Fire-and-forget — never throws.
 */
export async function updateMessageContent(messageId, newContent) {
    try {
        await queryWithRetry(
            'UPDATE message_logs SET content = ? WHERE message_id = ?',
            [newContent || null, messageId]
        );
    } catch (error) {
        logger.error('[MessageCache] Failed to update message content', {
            messageId,
            error: error.message
        });
    }
}

/**
 * Look up a single message by ID.
 * Returns the row object or null.
 */
export async function getMessageById(messageId) {
    try {
        const rows = await queryWithRetry(
            'SELECT message_id, guild_id, channel_id, author_id, author_tag, content, attachment_urls FROM message_logs WHERE message_id = ?',
            [messageId]
        );
        return rows.length > 0 ? rows[0] : null;
    } catch (error) {
        logger.error('[MessageCache] Failed to get message', {
            messageId,
            error: error.message
        });
        return null;
    }
}

/**
 * Retroactively cache recent messages from all text channels on bot startup.
 * Fetches the last 100 messages per channel and bulk-inserts them into the DB.
 * Skips messages already cached to avoid redundant writes.
 */
export async function seedMessageCache(client) {
    const startTime = Date.now();
    let totalCached = 0;
    let channelsProcessed = 0;
    let channelsSkipped = 0;

    for (const [, guild] of client.guilds.cache) {
        const textChannels = guild.channels.cache.filter(
            c => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
                 c.permissionsFor(guild.members.me)?.has(['ViewChannel', 'ReadMessageHistory'])
        );

        for (const [, channel] of textChannels) {
            try {
                const messages = await channel.messages.fetch({ limit: 50 });
                if (messages.size === 0) {
                    channelsSkipped++;
                    continue;
                }

                // Build bulk insert — skip bot messages and messages with no content
                const rows = [];
                for (const [, msg] of messages) {
                    if (msg.author.bot) continue;
                    const attachmentUrls = msg.attachments.size > 0
                        ? JSON.stringify([...msg.attachments.values()].map(a => a.url))
                        : null;
                    rows.push([
                        msg.id,
                        guild.id,
                        channel.id,
                        msg.author.id,
                        msg.author.tag || msg.author.username,
                        msg.content || null,
                        attachmentUrls
                    ]);
                }

                // Clear fetched messages from Discord.js cache — they're in the DB now
                channel.messages.cache.clear();

                if (rows.length === 0) {
                    channelsSkipped++;
                    continue;
                }

                // Bulk insert with ON DUPLICATE KEY to skip already-cached messages
                const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
                const flatValues = rows.flat();

                await pool.execute(
                    `INSERT IGNORE INTO message_logs (message_id, guild_id, channel_id, author_id, author_tag, content, attachment_urls)
                     VALUES ${placeholders}`,
                    flatValues
                );

                totalCached += rows.length;
                channelsProcessed++;
            } catch (error) {
                channelsSkipped++;
                // Missing Access, etc. — silently skip
                if (!error.message.includes('Missing Access') && !error.message.includes('Missing Permissions')) {
                    logger.warn(`[MessageCache Seed] Error in #${channel.name} (${guild.name}): ${error.message}`);
                }
            }
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[MessageCache Seed] Cached ${totalCached} messages from ${channelsProcessed} channels in ${elapsed}s (${channelsSkipped} skipped)`);
}

/**
 * Look up multiple messages by ID (for bulk delete enrichment).
 * Returns a Map<messageId, row>.
 */
export async function getMessagesByIds(messageIds) {
    if (!messageIds || messageIds.length === 0) return new Map();

    try {
        const placeholders = messageIds.map(() => '?').join(',');
        const rows = await queryWithRetry(
            `SELECT message_id, guild_id, channel_id, author_id, author_tag, content, attachment_urls
             FROM message_logs WHERE message_id IN (${placeholders})`,
            messageIds
        );

        const map = new Map();
        for (const row of rows) {
            map.set(row.message_id, row);
        }
        return map;
    } catch (error) {
        logger.error('[MessageCache] Failed to get messages in bulk', {
            count: messageIds.length,
            error: error.message
        });
        return new Map();
    }
}
