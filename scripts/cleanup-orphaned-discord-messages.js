// Manually clean up orphaned Discord announcement messages
// These are messages that exist in Discord but not in the database

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '/root/discord_bots/CertiFriedUtility/utils/db.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

async function cleanupOrphanedMessages() {
    try {
        await client.login(process.env.DISCORD_TOKEN);
        console.log('✓ Bot logged in');

        const connection = await pool.getConnection();

        // Get all announcement channels
        const [channels] = await connection.query(`
            SELECT DISTINCT announcement_channel_id
            FROM guilds
            WHERE announcement_channel_id IS NOT NULL
            UNION
            SELECT DISTINCT announcement_channel_id
            FROM twitch_teams
            WHERE announcement_channel_id IS NOT NULL
        `);

        console.log(`Checking ${channels.length} announcement channels for orphaned messages...`);

        let totalDeleted = 0;

        for (const { announcement_channel_id } of channels) {
            try {
                const channel = await client.channels.fetch(announcement_channel_id);
                if (!channel || !channel.isTextBased()) continue;

                console.log(`Checking channel ${channel.name} (${announcement_channel_id})...`);

                // Fetch recent messages (last 100)
                const messages = await channel.messages.fetch({ limit: 100 });

                for (const [messageId, message] of messages) {
                    // Skip non-webhook messages
                    if (!message.webhookId) continue;

                    // Check if this message is tracked in database
                    const [tracked] = await connection.query(
                        'SELECT id FROM live_announcements WHERE message_id = ?',
                        [messageId]
                    );

                    // If not tracked and is a webhook message, it's orphaned
                    if (tracked.length === 0) {
                        try {
                            await message.delete();
                            totalDeleted++;
                            console.log(`  ✓ Deleted orphaned message ${messageId}`);
                        } catch (deleteError) {
                            console.log(`  ✗ Failed to delete message ${messageId}: ${deleteError.message}`);
                        }
                    }
                }
            } catch (channelError) {
                console.log(`  ✗ Failed to check channel ${announcement_channel_id}: ${channelError.message}`);
            }
        }

        connection.release();
        console.log(`\n✓ Cleanup complete. Deleted ${totalDeleted} orphaned Discord messages.`);
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

cleanupOrphanedMessages();
