/**
 * Auto-Thread for Grow Journals
 * Automatically creates a thread when someone posts in grow journal channels
 */

import { ChannelType } from 'discord.js';
import logger from '../utils/logger.js';

// Channel name keywords that should auto-thread
const JOURNAL_KEYWORDS = ['grow-journal', 'growjournal', 'grow-diary', 'growdiary', 'plant-journal'];

export default {
    name: 'messageCreate',
    async execute(message) {
        // Ignore bots, DMs, threads, and system messages
        if (message.author.bot || !message.guild || message.system) return;
        if (message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread) return;

        // Check if this is a journal channel
        const channelName = message.channel.name?.toLowerCase() || '';
        const isJournalChannel = JOURNAL_KEYWORDS.some(keyword => channelName.includes(keyword));

        if (!isJournalChannel) return;

        // Only create threads for messages with content or images
        const hasContent = message.content && message.content.length > 10;
        const hasImage = message.attachments.some(a => a.contentType?.startsWith('image/'));

        if (!hasContent && !hasImage) return;

        try {
            // Generate thread name from message content or username
            let threadName = '';

            if (message.content) {
                // Use first line of message, truncated
                const firstLine = message.content.split('\n')[0];
                threadName = firstLine.substring(0, 50);
                if (firstLine.length > 50) threadName += '...';
            }

            if (!threadName || threadName.length < 3) {
                // Fallback to username's grow
                threadName = `${message.author.username}'s Grow`;
            }

            // Create the thread
            const thread = await message.startThread({
                name: threadName,
                autoArchiveDuration: 10080, // 7 days
                reason: 'Auto-created grow journal thread'
            });

            // Send a welcome message in the thread
            await thread.send({
                content: `🌱 **Grow Journal Started!**\n\nThis thread was auto-created for your grow journal post. Use this thread to:\n• Post updates and progress pics\n• Get feedback from the community\n• Track your grow from start to finish\n\nGood luck with your grow, ${message.author}! 🪴`
            });

            logger.info(`[AutoThread] Created journal thread`, {
                guildId: message.guild.id,
                channelId: message.channel.id,
                threadId: thread.id,
                userId: message.author.id
            });

        } catch (error) {
            // Thread creation might fail if one already exists or permissions issue
            logger.debug(`[AutoThread] Could not create thread: ${error.message}`);
        }
    }
};
