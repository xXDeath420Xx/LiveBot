// Manually trigger stale announcement cleanup
// This will force delete the jeffdank90 announcement that has offline_check_count = 10

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

async function forceCleanup() {
    try {
        await client.login(process.env.DISCORD_TOKEN);
        console.log('✓ Bot logged in');

        const connection = await pool.getConnection();

        // Find announcements with high offline_check_count that should have been deleted
        const [stuckAnnouncements] = await connection.query(`
            SELECT *
            FROM live_announcements
            WHERE offline_check_count >= 4
        `);

        console.log(`Found ${stuckAnnouncements.length} stuck announcements with offline_check_count >= 4`);

        for (const announcement of stuckAnnouncements) {
            try {
                console.log(`\nDeleting announcement for ${announcement.username} (${announcement.platform})`);
                console.log(`  - offline_check_count: ${announcement.offline_check_count}`);
                console.log(`  - message_id: ${announcement.message_id}`);
                console.log(`  - channel_id: ${announcement.channel_id}`);

                // Try to delete the Discord message
                try {
                    const channel = await client.channels.fetch(announcement.channel_id);
                    if (channel && channel.isTextBased()) {
                        const message = await channel.messages.fetch(announcement.message_id).catch(() => null);
                        if (message) {
                            await message.delete();
                            console.log(`  ✓ Deleted Discord message`);
                        } else {
                            console.log(`  ! Message not found in Discord (already deleted?)`);
                        }
                    }
                } catch (discordError) {
                    console.log(`  ! Failed to delete Discord message: ${discordError.message}`);
                }

                // Delete from database
                await connection.query('DELETE FROM live_announcements WHERE id = ?', [announcement.id]);
                console.log(`  ✓ Deleted from database`);

            } catch (error) {
                console.error(`  ✗ Error deleting announcement ${announcement.id}:`, error.message);
            }
        }

        connection.release();
        console.log(`\n✓ Cleanup complete`);
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

forceCleanup();
