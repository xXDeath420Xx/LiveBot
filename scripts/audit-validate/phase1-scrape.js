/**
 * Phase 1: Fresh Scrape
 * Re-fetches ALL messages from both audit channels via Discord REST API.
 * Captures full content (no truncation), improved ID classification,
 * and aggregates ALL reports per user_id.
 *
 * Output: audit-raw-scrape-YYYY-MM-DD.json
 */

import { REST } from 'discord.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CHANNELS } from './lib/constants.js';
import { fetchAllMessages } from './lib/scraper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');

/**
 * Run phase 1: scrape all messages and aggregate by offender.
 * @param {REST} rest - Discord REST client
 * @returns {Object} { offenders: Map<userId, aggregatedData>, outputPath }
 */
export async function runPhase1(rest) {
    console.log('\n=== Phase 1: Fresh Channel Scrape ===\n');

    const allMessages = [];
    const stats = { totalMessages: 0, totalReportedIds: 0, channels: {} };

    for (const [channelId, config] of Object.entries(CHANNELS)) {
        try {
            const messages = await fetchAllMessages(rest, channelId);

            // Tag each message with its source channel config
            for (const msg of messages) {
                msg.channelId = channelId;
                msg.channelCategory = config.category;
                msg.channelLabel = config.label;
            }

            allMessages.push(...messages);

            const reportedCount = messages.reduce((sum, m) => sum + m.reportedIds.length, 0);
            stats.channels[channelId] = {
                label: config.label,
                messages: messages.length,
                reportedIds: reportedCount,
            };
            stats.totalMessages += messages.length;
            stats.totalReportedIds += reportedCount;
        } catch (err) {
            console.error(`Error scraping channel ${channelId}:`, err.message);
        }
    }

    // Aggregate ALL reports per offender (don't deduplicate to first-seen)
    const offenders = new Map();

    for (const msg of allMessages) {
        for (const userId of msg.reportedIds) {
            if (!offenders.has(userId)) {
                offenders.set(userId, {
                    user_id: userId,
                    reports: [],
                    channels: new Set(),
                    reporters: new Set(),
                    allContent: [],
                    imageUrls: [],
                });
            }

            const offender = offenders.get(userId);
            offender.reports.push({
                messageId: msg.messageId,
                channelId: msg.channelId,
                channelLabel: msg.channelLabel,
                channelCategory: msg.channelCategory,
                authorId: msg.authorId,
                authorName: msg.authorName,
                timestamp: msg.timestamp,
                content: msg.content,
            });
            offender.channels.add(msg.channelId);
            offender.reporters.add(msg.authorName);
            offender.allContent.push(msg.content);
            offender.imageUrls.push(...msg.imageUrls);
        }
    }

    // Convert Sets to arrays for JSON serialization
    const offendersArray = [...offenders.values()].map(o => ({
        ...o,
        channels: [...o.channels],
        reporters: [...o.reporters],
        reportCount: o.reports.length,
    }));

    // Write output
    const date = new Date().toISOString().split('T')[0];
    const outputPath = join(PROJECT_ROOT, `audit-raw-scrape-${date}.json`);
    const output = {
        generated: new Date().toISOString(),
        stats: {
            ...stats,
            uniqueOffenders: offendersArray.length,
        },
        offenders: offendersArray,
    };

    writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\nPhase 1 complete — ${offendersArray.length} unique offenders from ${stats.totalMessages} messages`);
    console.log(`Output: ${outputPath}`);

    return { offenders: offendersArray, outputPath, stats: output.stats };
}
