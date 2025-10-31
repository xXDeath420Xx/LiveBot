const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Use existing database connection - it exports a pool
const { db } = require('./utils/db.js');

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

async function cleanupSpamChannels() {
    try {
        console.log('🧹 Starting spam cleanup...');

        // Get valid message IDs from database (messages we should keep)
        const [validAnnouncements] = await db.execute(
            'SELECT message_id, channel_id, username, platform FROM live_announcements WHERE channel_id IN (?, ?)',
            CHANNELS_TO_CLEAN
        );

        const validMessageIds = new Set(validAnnouncements.map(a => a.message_id));
        console.log(`✅ Found ${validMessageIds.size} valid announcements in database`);

        // Log valid announcements for reference
        console.log('\n📋 Valid announcements to keep:');
        validAnnouncements.forEach(ann => {
            console.log(`  - ${ann.username} (${ann.platform}) in channel ${ann.channel_id}: ${ann.message_id}`);
        });

        for (const channelId of CHANNELS_TO_CLEAN) {
            console.log(`\n🔍 Processing channel ${channelId}...`);

            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) {
                console.log(`❌ Could not find channel or it's not a text channel`);
                continue;
            }

            console.log(`📥 Fetching all messages...`);
            let allMessages = [];
            let lastId;

            // Fetch all messages (Discord limits to 100 per request)
            while (true) {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;

                const messages = await channel.messages.fetch(options);
                if (messages.size === 0) break;

                allMessages.push(...messages.values());
                lastId = messages.last().id;

                console.log(`  Fetched ${allMessages.length} messages so far...`);

                if (messages.size < 100) break;
            }

            console.log(`📊 Total messages in channel: ${allMessages.length}`);

            // Filter messages - delete any that aren't in our valid set
            const messagesToDelete = allMessages.filter(msg => {
                // Delete bot's own messages OR webhook messages that aren't in valid set
                const isBotMessage = msg.author.id === client.user.id;
                const isWebhookMessage = msg.webhookId !== null;
                const isNotValid = !validMessageIds.has(msg.id);

                return (isBotMessage || isWebhookMessage) && isNotValid;
            });

            console.log(`🗑️  Messages to delete: ${messagesToDelete.length}`);
            console.log(`✅ Messages to keep: ${allMessages.filter(m => validMessageIds.has(m.id)).length}`);

            if (messagesToDelete.length === 0) {
                console.log(`✨ Channel is already clean!`);
                continue;
            }

            // Delete messages using bulk delete (max 100 at a time, only for messages < 14 days old)
            console.log(`\n🧹 Starting deletion...`);
            let deletedCount = 0;

            // Separate messages by age (Discord bulk delete only works for messages < 14 days old)
            const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
            const recentMessages = messagesToDelete.filter(m => m.createdTimestamp > twoWeeksAgo);
            const oldMessages = messagesToDelete.filter(m => m.createdTimestamp <= twoWeeksAgo);

            console.log(`  Recent messages (bulk delete): ${recentMessages.length}`);
            console.log(`  Old messages (individual delete): ${oldMessages.length}`);

            // Bulk delete recent messages in batches of 100
            if (recentMessages.length > 0) {
                const bulkBatches = [];
                for (let i = 0; i < recentMessages.length; i += 100) {
                    bulkBatches.push(recentMessages.slice(i, i + 100));
                }

                console.log(`  Processing ${bulkBatches.length} bulk delete batch(es)...`);
                for (let i = 0; i < bulkBatches.length; i++) {
                    try {
                        const batch = bulkBatches[i];
                        await channel.bulkDelete(batch, true);
                        deletedCount += batch.length;
                        console.log(`  Bulk deleted batch ${i + 1}/${bulkBatches.length} (${batch.length} messages) - Total: ${deletedCount}/${messagesToDelete.length}`);
                        // Wait 1 second between batches to avoid rate limits
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (error) {
                        console.error(`  ⚠️  Failed to bulk delete batch ${i + 1}: ${error.message}`);
                    }
                }
            }

            // Delete old messages individually
            if (oldMessages.length > 0) {
                console.log(`  Processing ${oldMessages.length} old message(s) individually...`);
                for (let i = 0; i < oldMessages.length; i++) {
                    try {
                        await oldMessages[i].delete();
                        deletedCount++;
                        if ((i + 1) % 10 === 0) {
                            console.log(`  Deleted ${i + 1}/${oldMessages.length} old messages...`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (error) {
                        console.error(`  ⚠️  Failed to delete old message: ${error.message}`);
                    }
                }
            }

            console.log(`✅ Deleted ${deletedCount} spam messages from channel ${channelId}`);
        }

        console.log('\n🎉 Cleanup complete!');
        console.log('\n📊 Summary:');
        console.log(`  - Channels cleaned: ${CHANNELS_TO_CLEAN.length}`);
        console.log(`  - Valid announcements kept: ${validMessageIds.size}`);

    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    } finally {
        await db.end();
        client.destroy();
        process.exit(0);
    }
}

client.once('ready', () => {
    console.log(`🤖 Logged in as ${client.user.tag}`);
    cleanupSpamChannels();
});

client.login(process.env.DISCORD_BOT_TOKEN);
