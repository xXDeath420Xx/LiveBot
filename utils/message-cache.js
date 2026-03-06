import { queryWithRetry } from './db.js';
import logger from './logger.js';

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
