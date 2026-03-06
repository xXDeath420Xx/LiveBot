/**
 * Channel message fetcher — no content truncation.
 * Paginates through all messages in a channel via Discord REST API.
 */

import { Routes } from 'discord.js';
import { extractAndClassifyIds } from './classifier.js';

/**
 * Fetch all messages from a channel, with full content preserved.
 * @param {REST} rest - Discord REST client
 * @param {string} channelId - Channel to scrape
 * @returns {Array} All messages with classified IDs
 */
export async function fetchAllMessages(rest, channelId) {
    const allMessages = [];
    let lastId = null;
    let hasMore = true;
    let page = 0;

    console.log(`\n[Channel ${channelId}] Starting message fetch...`);

    while (hasMore) {
        const query = new URLSearchParams({ limit: '100' });
        if (lastId) query.set('before', lastId);

        const messages = await rest.get(Routes.channelMessages(channelId), { query });

        if (!messages.length) break;

        for (const msg of messages) {
            const content = msg.content || '';
            const { classifiedIds, reportedIds, skippedIds } = extractAndClassifyIds(content, msg.author.id);

            const imageAttachments = (msg.attachments || [])
                .filter(a => a.content_type?.startsWith('image/'));

            allMessages.push({
                messageId: msg.id,
                authorId: msg.author.id,
                authorName: msg.author.username,
                timestamp: msg.timestamp,
                content,  // Full content — no truncation
                classifiedIds,
                reportedIds,
                skippedIds,
                imageUrls: imageAttachments.map(a => a.url),
            });

            lastId = msg.id;
        }

        page++;
        if (page % 5 === 0) {
            console.log(`  ...fetched ${allMessages.length} messages so far`);
        }

        if (messages.length < 100) hasMore = false;
    }

    console.log(`[Channel ${channelId}] Done — ${allMessages.length} total messages`);
    return allMessages;
}
