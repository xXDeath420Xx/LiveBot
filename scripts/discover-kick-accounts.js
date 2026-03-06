import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getKickUser } from '../utils/platforms/kick.js';

async function discoverAndLinkKickAccounts() {
    let connection;
    try {
        connection = await pool.getConnection();

        console.log('\n' + '='.repeat(80));
        console.log('KICK ACCOUNT DISCOVERY AND LINKING');
        console.log('='.repeat(80));

        // Get all Twitch streamers with Discord IDs that DON'T have a matching Kick account
        const [twitchStreamers] = await connection.execute(`
            SELECT DISTINCT s.streamer_id, s.username, s.discord_user_id
            FROM streamers s
            WHERE s.platform = 'twitch'
              AND s.discord_user_id IS NOT NULL
              AND s.discord_user_id != ''
              AND NOT EXISTS (
                  SELECT 1 FROM streamers k
                  WHERE k.platform = 'kick'
                    AND LOWER(k.username) = LOWER(s.username)
              )
            ORDER BY s.username
        `);

        console.log(`\nFound ${twitchStreamers.length} Twitch streamers WITHOUT matching Kick accounts`);
        console.log('Searching Kick.com for matching profiles using CycleTLS...\n');

        let foundCount = 0;
        let notFoundCount = 0;
        let errorCount = 0;
        let linkedStreamers = [];

        for (const twitch of twitchStreamers) {
            // Search Kick.com for this username using CycleTLS web scraping
            try {
                console.log(`  🔍 Searching Kick for: ${twitch.username}...`);

                const kickUser = await getKickUser(twitch.username);

                if (kickUser && kickUser.id) {
                    // Extract username from Kick response (can be in slug or user.username)
                    const kickUsername = kickUser.slug || kickUser.user?.username || twitch.username;
                    const profilePic = kickUser.user?.profile_pic || null;

                    console.log(`  ✅ FOUND: ${kickUsername} (ID: ${kickUser.id})`);

                    // Create temporary platform_user_id (will be updated by stream checker)
                    const platformUserId = kickUser.id.toString();

                    // Insert the Kick streamer
                    const [insertResult] = await connection.execute(`
                        INSERT INTO streamers (platform, username, platform_user_id, discord_user_id, profile_image_url)
                        VALUES (?, ?, ?, ?, ?)
                    `, ['kick', kickUsername, platformUserId, twitch.discord_user_id, profilePic]);

                    const newKickStreamerId = insertResult.insertId;
                    console.log(`     → Created Kick streamer (ID: ${newKickStreamerId})`);
                    console.log(`     → Linked to Discord user: ${twitch.discord_user_id}`);

                    // Get all guilds and settings where this Twitch streamer is subscribed
                    const [twitchSubs] = await connection.execute(`
                        SELECT
                            sub.guild_id,
                            sub.announcement_channel_id,
                            sub.live_role_id,
                            sub.override_nickname,
                            sub.custom_message,
                            sub.delete_on_end,
                            sub.team_subscription_id
                        FROM subscriptions sub
                        WHERE sub.streamer_id = ?
                    `, [twitch.streamer_id]);

                    // Create matching Kick subscriptions in all guilds
                    for (const sub of twitchSubs) {
                        await connection.execute(`
                            INSERT INTO subscriptions
                            (guild_id, streamer_id, announcement_channel_id, live_role_id,
                             override_nickname, custom_message, delete_on_end, team_subscription_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `, [
                            sub.guild_id,
                            newKickStreamerId,
                            sub.announcement_channel_id,
                            sub.live_role_id,
                            sub.override_nickname,
                            sub.custom_message,
                            sub.delete_on_end,
                            sub.team_subscription_id
                        ]);

                        console.log(`     → Created subscription in guild ${sub.guild_id}`);
                    }

                    foundCount++;
                    linkedStreamers.push({
                        username: kickUsername,
                        discord_user_id: twitch.discord_user_id,
                        guilds: twitchSubs.length
                    });

                    // Add a small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    console.log(`  ❌ Not found on Kick: ${twitch.username}`);
                    notFoundCount++;
                }
            } catch (error) {
                if (error.message && error.message.includes('404')) {
                    console.log(`  ❌ Not found on Kick: ${twitch.username}`);
                    notFoundCount++;
                } else {
                    console.log(`  ⚠️  Error checking ${twitch.username}: ${error.message}`);
                    errorCount++;
                }

                // Add a small delay even on error
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('SUMMARY');
        console.log('='.repeat(80));
        console.log(`Total Twitch streamers checked: ${twitchStreamers.length}`);
        console.log(`✅ New Kick accounts found and linked: ${foundCount}`);
        console.log(`❌ Not found on Kick: ${notFoundCount}`);
        console.log(`⚠️  Errors: ${errorCount}`);

        if (linkedStreamers.length > 0) {
            console.log('\n' + '='.repeat(80));
            console.log('NEWLY LINKED KICK ACCOUNTS:');
            console.log('='.repeat(80));
            linkedStreamers.forEach(s => {
                console.log(`  • ${s.username}`);
                console.log(`    Discord ID: ${s.discord_user_id}`);
                console.log(`    Subscribed in ${s.guilds} guild(s)`);
            });
        }

        console.log('='.repeat(80) + '\n');

        return {
            found: foundCount,
            notFound: notFoundCount,
            errors: errorCount,
            linkedStreamers
        };

    } catch (error) {
        console.error('Fatal error during Kick account discovery:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

// Run if called directly
discoverAndLinkKickAccounts()
    .then((result) => {
        console.log('✅ Kick account discovery completed!');
        console.log(`Found and linked ${result.found} new Kick accounts`);
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Kick account discovery failed:', error);
        process.exit(1);
    });
