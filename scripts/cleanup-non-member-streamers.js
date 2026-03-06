import { Client, GatewayIntentBits } from 'discord.js';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const TARGET_GUILD_ID = '844406178799943730';

// Database connection
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
};

// Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

async function cleanupNonMemberStreamers() {
    console.log('='.repeat(80));
    console.log('Non-Member Streamer Cleanup Script');
    console.log('Target Guild ID:', TARGET_GUILD_ID);
    console.log('='.repeat(80));
    console.log();

    let connection;

    try {
        // Connect to database
        console.log('[1/5] Connecting to database...');
        connection = await mysql.createConnection(dbConfig);
        console.log('✓ Database connected');
        console.log();

        // Login to Discord
        console.log('[2/5] Logging into Discord...');
        await client.login(process.env.DISCORD_TOKEN);
        console.log('✓ Discord connected');
        console.log();

        // Fetch the target guild
        console.log('[3/5] Fetching guild...');
        const guild = await client.guilds.fetch(TARGET_GUILD_ID);
        console.log(`✓ Guild fetched: ${guild.name}`);
        console.log();

        // Fetch all guild members
        console.log('[4/5] Fetching all guild members...');
        await guild.members.fetch();
        const memberIds = new Set(guild.members.cache.keys());
        console.log(`✓ Guild has ${memberIds.size} members`);
        console.log();

        // Query all subscriptions for this guild with streamer info
        console.log('[5/5] Checking subscriptions and streamers...');
        const [subscriptions] = await connection.query(`
            SELECT
                sub.subscription_id,
                sub.guild_id,
                sub.announcement_channel_id,
                s.streamer_id,
                s.platform,
                s.username,
                s.discord_user_id
            FROM subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            WHERE sub.guild_id = ?
        `, [TARGET_GUILD_ID]);

        console.log(`Found ${subscriptions.length} total subscriptions in this guild`);
        console.log();

        // Track statistics
        const stats = {
            totalChecked: 0,
            withDiscordLink: 0,
            nonMembers: 0,
            messagesDeleted: 0,
            subscriptionsRemoved: 0,
            announcementsDeleted: 0
        };

        const toRemove = [];

        // Check each subscription
        for (const sub of subscriptions) {
            stats.totalChecked++;

            // Only check streamers with a Discord link
            if (!sub.discord_user_id) {
                continue;
            }

            stats.withDiscordLink++;

            // Check if this Discord user is a member of the guild
            const isMember = memberIds.has(sub.discord_user_id);

            if (!isMember) {
                stats.nonMembers++;
                console.log(`⚠️  NON-MEMBER FOUND:`);
                console.log(`   Platform: ${sub.platform}`);
                console.log(`   Username: ${sub.username}`);
                console.log(`   Discord User ID: ${sub.discord_user_id}`);
                console.log(`   Subscription ID: ${sub.subscription_id}`);
                console.log(`   Streamer ID: ${sub.streamer_id}`);

                toRemove.push({
                    subscription_id: sub.subscription_id,
                    streamer_id: sub.streamer_id,
                    platform: sub.platform,
                    username: sub.username,
                    discord_user_id: sub.discord_user_id,
                    announcement_channel_id: sub.announcement_channel_id
                });
            }
        }

        console.log();
        console.log('='.repeat(80));
        console.log('SUMMARY');
        console.log('='.repeat(80));
        console.log(`Total subscriptions checked: ${stats.totalChecked}`);
        console.log(`Subscriptions with Discord link: ${stats.withDiscordLink}`);
        console.log(`Non-member streamers found: ${stats.nonMembers}`);
        console.log();

        if (toRemove.length === 0) {
            console.log('✓ No non-member streamers found. Nothing to clean up.');
            return;
        }

        // Show what will be removed
        console.log('The following will be removed:');
        console.log();
        toRemove.forEach((item, index) => {
            console.log(`${index + 1}. ${item.platform} - ${item.username} (Discord: ${item.discord_user_id})`);
        });
        console.log();

        // Confirm deletion
        console.log('⚠️  WARNING: This will:');
        console.log('   1. Delete all live announcement messages for these streamers');
        console.log('   2. Remove announcements from live_announcements table');
        console.log('   3. Delete subscriptions from subscriptions table');
        console.log();
        console.log('Starting cleanup in 3 seconds...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        console.log();

        // Process removals
        console.log('='.repeat(80));
        console.log('CLEANUP PROCESS');
        console.log('='.repeat(80));
        console.log();

        for (const item of toRemove) {
            console.log(`Processing: ${item.platform} - ${item.username}`);

            try {
                // 1. Find and delete Discord messages
                const [announcements] = await connection.query(`
                    SELECT id, message_id, channel_id
                    FROM live_announcements
                    WHERE streamer_id = ?
                    AND guild_id = ?
                `, [item.streamer_id, TARGET_GUILD_ID]);

                for (const announcement of announcements) {
                    try {
                        const channel = await client.channels.fetch(announcement.channel_id).catch(() => null);
                        if (channel && channel.isTextBased()) {
                            await channel.messages.delete(announcement.message_id).catch(() => {
                                console.log(`   ⚠️  Could not delete message ${announcement.message_id} (may already be deleted)`);
                            });
                            stats.messagesDeleted++;
                            console.log(`   ✓ Deleted message ${announcement.message_id} from channel ${announcement.channel_id}`);
                        }
                    } catch (error) {
                        console.log(`   ⚠️  Error deleting message: ${error.message}`);
                    }
                }

                // 2. Delete from live_announcements table
                if (announcements.length > 0) {
                    await connection.query(`
                        DELETE FROM live_announcements
                        WHERE streamer_id = ?
                        AND guild_id = ?
                    `, [item.streamer_id, TARGET_GUILD_ID]);
                    stats.announcementsDeleted += announcements.length;
                    console.log(`   ✓ Removed ${announcements.length} announcement(s) from database`);
                }

                // 3. Delete subscription
                await connection.query(`
                    DELETE FROM subscriptions
                    WHERE subscription_id = ?
                `, [item.subscription_id]);
                stats.subscriptionsRemoved++;
                console.log(`   ✓ Removed subscription ${item.subscription_id}`);
                console.log();

            } catch (error) {
                console.error(`   ❌ Error processing ${item.username}:`, error.message);
                console.log();
            }
        }

        // Final summary
        console.log('='.repeat(80));
        console.log('CLEANUP COMPLETE');
        console.log('='.repeat(80));
        console.log(`Discord messages deleted: ${stats.messagesDeleted}`);
        console.log(`Announcement records removed: ${stats.announcementsDeleted}`);
        console.log(`Subscriptions removed: ${stats.subscriptionsRemoved}`);
        console.log();
        console.log('✓ Cleanup complete!');

    } catch (error) {
        console.error('Fatal error:', error);
    } finally {
        // Cleanup
        if (connection) {
            await connection.end();
        }
        client.destroy();
        process.exit(0);
    }
}

// Run the cleanup
cleanupNonMemberStreamers();
