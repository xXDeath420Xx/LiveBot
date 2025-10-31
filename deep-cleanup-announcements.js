const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

const CHANNELS_TO_CLEAN = [
    '1415373602068496545',
    '1414766370217787573'
];

/**
 * Extract streamer username from a message
 * Looks at embed author, title, and content
 */
function extractStreamerInfo(message) {
    if (message.embeds && message.embeds.length > 0) {
        const embed = message.embeds[0];

        // Try to extract from author field (e.g., "cookiesays is LIVE on Kick!")
        if (embed.author && embed.author.name) {
            const match = embed.author.name.match(/^(.+?)\s+is\s+LIVE\s+on\s+(\w+)/i);
            if (match) {
                return {
                    username: match[1].toLowerCase(),
                    platform: match[2].toLowerCase(),
                    messageId: message.id,
                    createdTimestamp: message.createdTimestamp,
                    channelId: message.channelId
                };
            }
        }

        // Fallback: try to extract from URL
        if (embed.url) {
            const url = embed.url.toLowerCase();
            let username = null;
            let platform = null;

            if (url.includes('twitch.tv/')) {
                username = url.split('twitch.tv/')[1]?.split(/[/?]/)[0];
                platform = 'twitch';
            } else if (url.includes('kick.com/')) {
                username = url.split('kick.com/')[1]?.split(/[/?]/)[0];
                platform = 'kick';
            } else if (url.includes('youtube.com/')) {
                // YouTube URLs are more complex, skip for now
                platform = 'youtube';
            } else if (url.includes('trovo.live/')) {
                username = url.split('trovo.live/')[1]?.split(/[/?]/)[0];
                platform = 'trovo';
            }

            if (username && platform) {
                return {
                    username: username.toLowerCase(),
                    platform: platform,
                    messageId: message.id,
                    createdTimestamp: message.createdTimestamp,
                    channelId: message.channelId
                };
            }
        }
    }

    return null;
}

async function deepCleanupAnnouncements() {
    try {
        console.log('🔍 Starting deep cleanup of announcement channels...\n');

        let totalDeleted = 0;
        let totalKept = 0;

        for (const channelId of CHANNELS_TO_CLEAN) {
            console.log(`\n${'='.repeat(80)}`);
            console.log(`📢 Processing channel ${channelId}`);
            console.log(`${'='.repeat(80)}\n`);

            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) {
                console.log(`❌ Could not find channel or it's not a text channel`);
                continue;
            }

            console.log(`📥 Fetching all messages from channel...`);
            let allMessages = [];
            let lastId;
            let fetchCount = 0;

            // Fetch ALL messages from the channel
            while (true) {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;

                const messages = await channel.messages.fetch(options);
                if (messages.size === 0) break;

                allMessages.push(...messages.values());
                lastId = messages.last().id;
                fetchCount++;

                console.log(`  📦 Batch ${fetchCount}: Fetched ${messages.size} messages (total: ${allMessages.length})`);

                if (messages.size < 100) break;

                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            console.log(`\n✅ Total messages fetched: ${allMessages.length}`);

            // Filter to only bot/webhook messages with embeds
            const announcementMessages = allMessages.filter(msg => {
                const isBotOrWebhook = msg.author.bot || msg.webhookId !== null;
                const hasEmbeds = msg.embeds && msg.embeds.length > 0;
                return isBotOrWebhook && hasEmbeds;
            });

            console.log(`📊 Announcement messages (bot/webhook with embeds): ${announcementMessages.length}\n`);

            // Group messages by streamer
            const streamerGroups = new Map();
            const unidentified = [];

            for (const msg of announcementMessages) {
                const info = extractStreamerInfo(msg);
                if (info) {
                    const key = `${info.platform}:${info.username}`;
                    if (!streamerGroups.has(key)) {
                        streamerGroups.set(key, []);
                    }
                    streamerGroups.get(key).push({
                        message: msg,
                        ...info
                    });
                } else {
                    unidentified.push(msg);
                }
            }

            console.log(`👥 Identified ${streamerGroups.size} unique streamers`);
            console.log(`❓ Unidentified messages: ${unidentified.length}\n`);

            // For each streamer, keep only the NEWEST message, delete all others
            const messagesToDelete = [];
            let keptCount = 0;

            console.log(`📋 Analysis by streamer:\n`);

            for (const [key, messages] of streamerGroups.entries()) {
                // Sort by timestamp, newest first
                messages.sort((a, b) => b.createdTimestamp - a.createdTimestamp);

                const [platform, username] = key.split(':');
                const newestMsg = messages[0];
                const duplicates = messages.slice(1);

                console.log(`  ${platform.toUpperCase().padEnd(8)} | ${username.padEnd(20)} | ${messages.length} messages`);
                console.log(`    ✅ Keeping:  ${newestMsg.messageId} (${new Date(newestMsg.createdTimestamp).toISOString()})`);

                if (duplicates.length > 0) {
                    console.log(`    🗑️  Deleting: ${duplicates.length} older duplicates`);
                    duplicates.forEach(dup => {
                        console.log(`       - ${dup.messageId} (${new Date(dup.createdTimestamp).toISOString()})`);
                        messagesToDelete.push(dup.message);
                    });
                }

                keptCount++;
            }

            // Also delete unidentified messages (they're probably old/broken)
            if (unidentified.length > 0) {
                console.log(`\n  ❓ Unidentified messages: ${unidentified.length}`);
                console.log(`    🗑️  These will be deleted as they couldn't be parsed`);
                messagesToDelete.push(...unidentified);
            }

            console.log(`\n${'─'.repeat(80)}`);
            console.log(`📊 Summary for channel ${channelId}:`);
            console.log(`   Total messages fetched: ${allMessages.length}`);
            console.log(`   Announcement messages: ${announcementMessages.length}`);
            console.log(`   Unique streamers: ${streamerGroups.size}`);
            console.log(`   Messages to keep: ${keptCount}`);
            console.log(`   Messages to delete: ${messagesToDelete.length}`);
            console.log(`${'─'.repeat(80)}\n`);

            if (messagesToDelete.length === 0) {
                console.log(`✨ Channel is already clean! No duplicates found.\n`);
                totalKept += keptCount;
                continue;
            }

            // Delete messages
            console.log(`🧹 Starting deletion of ${messagesToDelete.length} messages...\n`);

            const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
            const recentMessages = messagesToDelete.filter(m => m.createdTimestamp > twoWeeksAgo);
            const oldMessages = messagesToDelete.filter(m => m.createdTimestamp <= twoWeeksAgo);

            console.log(`  📅 Recent messages (< 14 days, bulk delete): ${recentMessages.length}`);
            console.log(`  📅 Old messages (> 14 days, individual delete): ${oldMessages.length}\n`);

            let deletedCount = 0;

            // Bulk delete recent messages
            if (recentMessages.length > 0) {
                const bulkBatches = [];
                for (let i = 0; i < recentMessages.length; i += 100) {
                    bulkBatches.push(recentMessages.slice(i, i + 100));
                }

                console.log(`  🔄 Processing ${bulkBatches.length} bulk delete batch(es)...`);
                for (let i = 0; i < bulkBatches.length; i++) {
                    try {
                        const batch = bulkBatches[i];
                        await channel.bulkDelete(batch, true);
                        deletedCount += batch.length;
                        console.log(`     ✅ Batch ${i + 1}/${bulkBatches.length}: Deleted ${batch.length} messages (total: ${deletedCount}/${messagesToDelete.length})`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (error) {
                        console.error(`     ⚠️  Failed batch ${i + 1}: ${error.message}`);
                    }
                }
            }

            // Delete old messages individually
            if (oldMessages.length > 0) {
                console.log(`\n  🔄 Processing ${oldMessages.length} old message(s) individually...`);
                for (let i = 0; i < oldMessages.length; i++) {
                    try {
                        await oldMessages[i].delete();
                        deletedCount++;
                        if ((i + 1) % 10 === 0 || i === oldMessages.length - 1) {
                            console.log(`     ✅ Progress: ${i + 1}/${oldMessages.length} old messages deleted`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (error) {
                        console.error(`     ⚠️  Failed to delete message ${i + 1}: ${error.message}`);
                    }
                }
            }

            console.log(`\n✅ Channel ${channelId} cleanup complete!`);
            console.log(`   Deleted: ${deletedCount} duplicate/stale messages`);
            console.log(`   Kept: ${keptCount} unique streamer announcements\n`);

            totalDeleted += deletedCount;
            totalKept += keptCount;
        }

        console.log(`\n${'='.repeat(80)}`);
        console.log(`🎉 DEEP CLEANUP COMPLETE!`);
        console.log(`${'='.repeat(80)}`);
        console.log(`📊 Final Statistics:`);
        console.log(`   Channels processed: ${CHANNELS_TO_CLEAN.length}`);
        console.log(`   Total messages deleted: ${totalDeleted}`);
        console.log(`   Total unique announcements kept: ${totalKept}`);
        console.log(`   Cleanup ratio: ${totalDeleted > 0 ? ((totalDeleted / (totalDeleted + totalKept)) * 100).toFixed(1) : 0}% removed`);
        console.log(`${'='.repeat(80)}\n`);

    } catch (error) {
        console.error('❌ Error during deep cleanup:', error);
    } finally {
        client.destroy();
        process.exit(0);
    }
}

client.once('ready', () => {
    console.log(`🤖 Logged in as ${client.user.tag}\n`);
    deepCleanupAnnouncements();
});

client.login(process.env.DISCORD_BOT_TOKEN);
