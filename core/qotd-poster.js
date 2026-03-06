import { EmbedBuilder, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Post a QOTD card to a configured channel
 * @param {Client} client - Discord client
 * @param {Object} channelConfig - Channel configuration from qotd_channels table
 * @returns {Promise<Object>} Result object with success status and content
 */
export async function postQOTD(client, channelConfig) {
    try {
        // Get the channel
        const channel = await client.channels.fetch(channelConfig.channel_id).catch(() => null);
        if (!channel) {
            logger.warn('[QOTD] Channel not found', { channelId: channelConfig.channel_id });
            return { success: false, error: 'Channel not found' };
        }

        // Get active deck
        if (!channelConfig.active_deck_id) {
            logger.warn('[QOTD] No active deck configured', { channelId: channelConfig.channel_id });
            return { success: false, error: 'No active deck configured' };
        }

        // Check if there's a queue entry
        const [[queueEntry]] = await pool.execute(
            'SELECT * FROM qotd_queue WHERE channel_id = ? ORDER BY position LIMIT 1',
            [channelConfig.channel_id]
        );

        let card;

        if (queueEntry) {
            // Use queued card
            const [[queuedCard]] = await pool.execute(
                'SELECT * FROM qotd_cards WHERE card_id = ?',
                [queueEntry.card_id]
            );
            card = queuedCard;

            // Remove from queue
            await pool.execute(
                'DELETE FROM qotd_queue WHERE queue_id = ?',
                [queueEntry.queue_id]
            );

            // Reorder remaining queue items
            await pool.execute(
                'UPDATE qotd_queue SET position = position - 1 WHERE channel_id = ? AND position > ?',
                [channelConfig.channel_id, queueEntry.position]
            );
        } else {
            // Get next card based on mode
            if (channelConfig.mode === 'sequential') {
                // Get least recently used card
                const [[nextCard]] = await pool.execute(`
                    SELECT c.*
                    FROM qotd_cards c
                    WHERE c.deck_id = ?
                    ORDER BY c.last_used_at IS NULL DESC, c.last_used_at ASC, c.position ASC
                    LIMIT 1
                `, [channelConfig.active_deck_id]);
                card = nextCard;
            } else if (channelConfig.mode === 'random') {
                // Get random card
                const [[randomCard]] = await pool.execute(`
                    SELECT c.*
                    FROM qotd_cards c
                    WHERE c.deck_id = ?
                    ORDER BY RAND()
                    LIMIT 1
                `, [channelConfig.active_deck_id]);
                card = randomCard;
            }
        }

        if (!card) {
            logger.warn('[QOTD] No card found to post', {
                channelId: channelConfig.channel_id,
                deckId: channelConfig.active_deck_id
            });
            return { success: false, error: 'No cards available in the active deck' };
        }

        // Build embed
        const embed = new EmbedBuilder()
            .setColor(channelConfig.embed_color || '#5865f2')
            .setTitle(channelConfig.embed_title || 'Question of the Day')
            .setDescription(card.content)
            .setTimestamp();

        if (channelConfig.embed_description) {
            embed.setFooter({ text: channelConfig.embed_description });
        }

        if (card.image_url) {
            embed.setImage(card.image_url);
        }

        // Build message content (pings)
        let messageContent = null;
        if (channelConfig.ping_role_ids) {
            try {
                const roleIds = JSON.parse(channelConfig.ping_role_ids);
                messageContent = roleIds.map(id => `<@&${id}>`).join(' ');
            } catch (e) {
                logger.warn('[QOTD] Failed to parse ping role IDs', { error: e.message });
            }
        }

        // Send message
        const message = await channel.send({
            content: messageContent,
            embeds: [embed]
        });

        // Create thread if enabled
        let threadId = null;
        if (channelConfig.thread_enabled && channel.type === ChannelType.GuildText) {
            try {
                const threadName = channelConfig.thread_name || `Discussion: ${new Date().toLocaleDateString()}`;
                const thread = await message.startThread({
                    name: threadName.substring(0, 100), // Max 100 chars
                    autoArchiveDuration: 1440 // 24 hours
                });
                threadId = thread.id;
                logger.info('[QOTD] Created thread', { threadId, channelId: channelConfig.channel_id });
            } catch (e) {
                logger.warn('[QOTD] Failed to create thread', { error: e.message });
            }
        }

        // Pin message if enabled
        if (channelConfig.pin_message) {
            try {
                // Unpin previous QOTD if it exists
                const pinnedMessages = await channel.messages.fetchPinned();
                const previousQOTD = pinnedMessages.find(m =>
                    m.author.id === client.user.id &&
                    m.embeds.length > 0 &&
                    m.embeds[0].title === (channelConfig.embed_title || 'Question of the Day')
                );

                if (previousQOTD) {
                    await previousQOTD.unpin();
                }

                await message.pin();
            } catch (e) {
                logger.warn('[QOTD] Failed to pin message', { error: e.message });
            }
        }

        // Update card usage stats
        await pool.execute(
            'UPDATE qotd_cards SET times_used = times_used + 1, last_used_at = NOW() WHERE card_id = ?',
            [card.card_id]
        );

        // Update deck usage stats
        await pool.execute(
            'UPDATE qotd_decks SET times_used = times_used + 1 WHERE deck_id = ?',
            [channelConfig.active_deck_id]
        );

        // Update channel last posted time
        await pool.execute(
            'UPDATE qotd_channels SET last_posted_at = NOW() WHERE channel_id = ?',
            [channelConfig.channel_id]
        );

        // Record in history
        await pool.execute(
            'INSERT INTO qotd_history (channel_id, guild_id, card_id, message_id, thread_id) VALUES (?, ?, ?, ?, ?)',
            [channelConfig.channel_id, channelConfig.guild_id, card.card_id, message.id, threadId]
        );

        logger.info('[QOTD] Posted successfully', {
            channelId: channelConfig.channel_id,
            cardId: card.card_id,
            messageId: message.id
        });

        return {
            success: true,
            content: card.content,
            messageId: message.id,
            threadId
        };

    } catch (error) {
        logger.error('[QOTD] Error posting QOTD', {
            error: error.message,
            stack: error.stack,
            channelId: channelConfig?.channel_id
        });
        return { success: false, error: error.message };
    }
}

/**
 * Check if a QOTD should be posted based on schedule
 * @param {Object} channelConfig - Channel configuration
 * @returns {boolean} Whether to post
 */
export function shouldPost(channelConfig) {
    if (!channelConfig.enabled) return false;

    const now = new Date();
    const lastPosted = channelConfig.last_posted_at ? new Date(channelConfig.last_posted_at) : null;

    // Parse schedule time
    const [hours, minutes] = (channelConfig.schedule_time || '09:00').split(':').map(Number);
    const scheduledTime = new Date(now);
    scheduledTime.setHours(hours, minutes, 0, 0);

    if (channelConfig.schedule_type === 'daily') {
        // Post if:
        // 1. Never posted before, OR
        // 2. Last post was yesterday or earlier AND current time is past scheduled time
        if (!lastPosted) return now >= scheduledTime;

        const daysSincePost = Math.floor((now - lastPosted) / (1000 * 60 * 60 * 24));
        return daysSincePost >= 1 && now >= scheduledTime;
    }

    if (channelConfig.schedule_type === 'weekly') {
        // Parse schedule_days JSON array
        let scheduledDays = [];
        try {
            scheduledDays = channelConfig.schedule_days ? JSON.parse(channelConfig.schedule_days) : [];
        } catch (e) {
            logger.warn('[QOTD] Failed to parse schedule_days', { error: e.message });
            return false;
        }

        if (scheduledDays.length === 0) return false;

        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const currentDay = dayNames[now.getDay()];

        // Check if today is a scheduled day
        if (!scheduledDays.includes(currentDay)) return false;

        // Check if we've already posted today
        if (lastPosted) {
            const lastPostDay = new Date(lastPosted);
            lastPostDay.setHours(0, 0, 0, 0);
            const todayStart = new Date(now);
            todayStart.setHours(0, 0, 0, 0);

            if (lastPostDay.getTime() === todayStart.getTime()) {
                return false; // Already posted today
            }
        }

        return now >= scheduledTime;
    }

    if (channelConfig.schedule_type === 'custom') {
        // Custom interval in minutes
        if (!channelConfig.custom_interval_minutes) return false;
        if (!lastPosted) return true;

        const minutesSincePost = Math.floor((now - lastPosted) / (1000 * 60));
        return minutesSincePost >= channelConfig.custom_interval_minutes;
    }

    return false;
}
