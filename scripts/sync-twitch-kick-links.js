import pool from '../utils/db.js';
import logger from '../utils/logger.js';

async function syncTwitchKickLinks() {
    let connection;
    try {
        connection = await pool.getConnection();

        console.log('\n' + '='.repeat(80));
        console.log('STEP 1: Finding Twitch streamers with Discord IDs and matching Kick accounts');
        console.log('='.repeat(80));

        // Find all Twitch streamers with Discord IDs
        const [twitchStreamers] = await connection.execute(`
            SELECT streamer_id, username, discord_user_id
            FROM streamers
            WHERE platform = 'twitch'
              AND discord_user_id IS NOT NULL
              AND discord_user_id != ''
            ORDER BY username
        `);

        console.log(`Found ${twitchStreamers.length} Twitch streamers with Discord IDs\n`);

        let linkedCount = 0;
        let alreadyLinkedCount = 0;
        let differentUserCount = 0;

        for (const twitch of twitchStreamers) {
            // Look for matching Kick account (case-insensitive)
            const [kickMatches] = await connection.execute(`
                SELECT streamer_id, username, discord_user_id
                FROM streamers
                WHERE platform = 'kick'
                  AND LOWER(username) = LOWER(?)
            `, [twitch.username]);

            if (kickMatches.length > 0) {
                const kick = kickMatches[0];

                if (!kick.discord_user_id || kick.discord_user_id === '') {
                    // Kick account is unlinked - link it
                    await connection.execute(`
                        UPDATE streamers
                        SET discord_user_id = ?
                        WHERE streamer_id = ?
                    `, [twitch.discord_user_id, kick.streamer_id]);

                    console.log(`✓ Linked ${kick.username} (Kick) to Discord user ${twitch.discord_user_id} (matched with Twitch: ${twitch.username})`);
                    linkedCount++;
                } else if (kick.discord_user_id === twitch.discord_user_id) {
                    console.log(`  Already linked: ${kick.username} (Kick) ↔ ${twitch.username} (Twitch) → Discord ${twitch.discord_user_id}`);
                    alreadyLinkedCount++;
                } else {
                    console.log(`  ⚠ Skipped ${kick.username} (Kick) - already linked to different user: ${kick.discord_user_id} (Twitch ${twitch.username} uses ${twitch.discord_user_id})`);
                    differentUserCount++;
                }
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('STEP 2: Synchronizing subscriptions across servers');
        console.log('='.repeat(80));

        // For each Discord user, ensure their streamers are subscribed in all servers
        const [discordUsers] = await connection.execute(`
            SELECT DISTINCT discord_user_id
            FROM streamers
            WHERE discord_user_id IS NOT NULL AND discord_user_id != ''
        `);

        let subsSynced = 0;

        for (const user of discordUsers) {
            // Get all streamers for this Discord user
            const [userStreamers] = await connection.execute(`
                SELECT streamer_id, platform, username
                FROM streamers
                WHERE discord_user_id = ?
            `, [user.discord_user_id]);

            // Get all guilds where any of these streamers are subscribed
            const [guilds] = await connection.execute(`
                SELECT DISTINCT sub.guild_id
                FROM subscriptions sub
                JOIN streamers s ON sub.streamer_id = s.streamer_id
                WHERE s.discord_user_id = ?
            `, [user.discord_user_id]);

            console.log(`\nDiscord User ${user.discord_user_id}:`);
            console.log(`  - Has ${userStreamers.length} streamer account(s)`);
            console.log(`  - Tracked in ${guilds.length} guild(s)`);

            // For each streamer, ensure they're subscribed in all guilds
            for (const streamer of userStreamers) {
                for (const guild of guilds) {
                    // Check if subscription exists
                    const [existingSub] = await connection.execute(`
                        SELECT subscription_id
                        FROM subscriptions
                        WHERE guild_id = ? AND streamer_id = ?
                    `, [guild.guild_id, streamer.streamer_id]);

                    if (existingSub.length === 0) {
                        // Get announcement channel from another streamer in this guild for this user
                        const [refSub] = await connection.execute(`
                            SELECT sub.announcement_channel_id, sub.live_role_id, sub.delete_on_end
                            FROM subscriptions sub
                            JOIN streamers s ON sub.streamer_id = s.streamer_id
                            WHERE s.discord_user_id = ?
                              AND sub.guild_id = ?
                              AND sub.announcement_channel_id IS NOT NULL
                            LIMIT 1
                        `, [user.discord_user_id, guild.guild_id]);

                        const channelId = refSub.length > 0 ? refSub[0].announcement_channel_id : null;
                        const roleId = refSub.length > 0 ? refSub[0].live_role_id : null;
                        const deleteOnEnd = refSub.length > 0 ? refSub[0].delete_on_end : 1;

                        // Create subscription
                        await connection.execute(`
                            INSERT INTO subscriptions
                            (guild_id, streamer_id, announcement_channel_id, live_role_id, delete_on_end)
                            VALUES (?, ?, ?, ?, ?)
                        `, [guild.guild_id, streamer.streamer_id, channelId, roleId, deleteOnEnd]);

                        console.log(`    ✓ Added ${streamer.username} (${streamer.platform}) subscription to guild ${guild.guild_id}`);
                        subsSynced++;
                    }
                }
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('STEP 3: Syncing Kick announcement channels with Twitch channels');
        console.log('='.repeat(80));

        let channelsSynced = 0;

        // For each Kick subscription, if there's a matching Twitch subscription in the same guild with the same Discord user, copy the channel
        const [kickSubs] = await connection.execute(`
            SELECT
                sub.subscription_id,
                sub.guild_id,
                sub.streamer_id,
                sub.announcement_channel_id,
                s.username,
                s.discord_user_id
            FROM subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            WHERE s.platform = 'kick'
              AND s.discord_user_id IS NOT NULL
              AND s.discord_user_id != ''
        `);

        for (const kickSub of kickSubs) {
            // Find matching Twitch subscription in same guild with same Discord user
            const [twitchSub] = await connection.execute(`
                SELECT
                    sub.announcement_channel_id,
                    sub.live_role_id,
                    sub.delete_on_end,
                    s.username
                FROM subscriptions sub
                JOIN streamers s ON sub.streamer_id = s.streamer_id
                WHERE s.platform = 'twitch'
                  AND LOWER(s.username) = LOWER(?)
                  AND s.discord_user_id = ?
                  AND sub.guild_id = ?
                  AND sub.announcement_channel_id IS NOT NULL
                LIMIT 1
            `, [kickSub.username, kickSub.discord_user_id, kickSub.guild_id]);

            if (twitchSub.length > 0 && kickSub.announcement_channel_id !== twitchSub[0].announcement_channel_id) {
                // Update Kick subscription to use same channel as Twitch
                await connection.execute(`
                    UPDATE subscriptions
                    SET announcement_channel_id = ?,
                        live_role_id = ?,
                        delete_on_end = ?
                    WHERE subscription_id = ?
                `, [
                    twitchSub[0].announcement_channel_id,
                    twitchSub[0].live_role_id,
                    twitchSub[0].delete_on_end,
                    kickSub.subscription_id
                ]);

                console.log(`✓ Synced ${kickSub.username} (Kick) channel to match ${twitchSub[0].username} (Twitch) in guild ${kickSub.guild_id}`);
                channelsSynced++;
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('SUMMARY');
        console.log('='.repeat(80));
        console.log(`Discord ID Links:`);
        console.log(`  - New links created: ${linkedCount}`);
        console.log(`  - Already linked: ${alreadyLinkedCount}`);
        console.log(`  - Skipped (different user): ${differentUserCount}`);
        console.log(`\nSubscriptions:`);
        console.log(`  - Subscriptions synced across servers: ${subsSynced}`);
        console.log(`\nChannels:`);
        console.log(`  - Kick channels synced with Twitch: ${channelsSynced}`);
        console.log('='.repeat(80) + '\n');

        return {
            linked: linkedCount,
            alreadyLinked: alreadyLinkedCount,
            skipped: differentUserCount,
            subsSynced,
            channelsSynced
        };

    } catch (error) {
        console.error('Error during sync:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

// Run if called directly
syncTwitchKickLinks()
    .then(() => {
        console.log('✅ Sync completed successfully!');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Sync failed:', error);
        process.exit(1);
    });
