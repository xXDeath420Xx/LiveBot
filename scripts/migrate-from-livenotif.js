import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const GUILD_ID = '844406178799943730';

// Database connections
const livenotifConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: 'livenotif'
};

const certiFriedUtilityConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: 'CertiFriedUtility'
};

async function migrateStreamers() {
    let livenotifConn;
    let utilityConn;

    try {
        console.log('='.repeat(80));
        console.log('MIGRATION: livenotif -> CertiFriedUtility');
        console.log(`Guild ID: ${GUILD_ID}`);
        console.log('='.repeat(80));

        // Connect to both databases
        livenotifConn = await mysql.createConnection(livenotifConfig);
        utilityConn = await mysql.createConnection(certiFriedUtilityConfig);

        console.log('\n✓ Connected to both databases');

        // Query all streamers and subscriptions for this guild from livenotif
        const [sourceData] = await livenotifConn.execute(`
            SELECT
                s.streamer_id as source_streamer_id,
                s.platform,
                s.username,
                s.platform_user_id,
                s.discord_user_id,
                s.profile_image_url,
                sub.announcement_channel_id,
                sub.live_role_id,
                sub.custom_message,
                sub.override_nickname,
                sub.override_avatar_url,
                sub.delete_on_end
            FROM subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            WHERE sub.guild_id = ?
            ORDER BY s.username
        `, [GUILD_ID]);

        console.log(`\n✓ Found ${sourceData.length} subscriptions in livenotif database`);

        let streamersCreated = 0;
        let streamersExisting = 0;
        let subscriptionsCreated = 0;
        let subscriptionsExisting = 0;
        let errors = [];

        for (const row of sourceData) {
            try {
                console.log(`\n  Processing: ${row.platform.toUpperCase()} - ${row.username}`);

                // Step 1: Find or create streamer in CertiFriedUtility
                const [existingStreamers] = await utilityConn.execute(`
                    SELECT streamer_id FROM streamers
                    WHERE platform = ? AND LOWER(username) = LOWER(?)
                `, [row.platform, row.username]);

                let targetStreamerId;

                if (existingStreamers.length > 0) {
                    targetStreamerId = existingStreamers[0].streamer_id;
                    console.log(`    → Streamer already exists (ID: ${targetStreamerId})`);
                    streamersExisting++;

                    // Update discord_user_id if it's set in source but not in target
                    if (row.discord_user_id) {
                        const [currentStreamer] = await utilityConn.execute(
                            'SELECT discord_user_id FROM streamers WHERE streamer_id = ?',
                            [targetStreamerId]
                        );

                        if (!currentStreamer[0].discord_user_id) {
                            await utilityConn.execute(
                                'UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?',
                                [row.discord_user_id, targetStreamerId]
                            );
                            console.log(`    → Updated Discord ID: ${row.discord_user_id}`);
                        }
                    }
                } else {
                    // Create new streamer
                    const platformUserId = row.platform_user_id || `temp_${row.username}_${Date.now()}`;
                    const [insertResult] = await utilityConn.execute(`
                        INSERT INTO streamers (platform, username, platform_user_id, discord_user_id, profile_image_url)
                        VALUES (?, ?, ?, ?, ?)
                    `, [
                        row.platform,
                        row.username,
                        platformUserId,
                        row.discord_user_id || null,
                        row.profile_image_url || null
                    ]);

                    targetStreamerId = insertResult.insertId;
                    console.log(`    → Created new streamer (ID: ${targetStreamerId})`);
                    streamersCreated++;
                }

                // Step 2: Find or create subscription in CertiFriedUtility
                const [existingSubscriptions] = await utilityConn.execute(`
                    SELECT subscription_id FROM subscriptions
                    WHERE guild_id = ? AND streamer_id = ?
                `, [GUILD_ID, targetStreamerId]);

                if (existingSubscriptions.length > 0) {
                    console.log(`    → Subscription already exists (ID: ${existingSubscriptions[0].subscription_id})`);
                    subscriptionsExisting++;
                } else {
                    // Create new subscription
                    await utilityConn.execute(`
                        INSERT INTO subscriptions
                        (guild_id, streamer_id, announcement_channel_id, live_role_id, custom_message,
                         override_nickname, override_avatar_url, delete_on_end)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        GUILD_ID,
                        targetStreamerId,
                        row.announcement_channel_id || null,
                        row.live_role_id || null,
                        row.custom_message || null,
                        row.override_nickname || null,
                        row.override_avatar_url || null,
                        row.delete_on_end !== null ? row.delete_on_end : 1
                    ]);

                    console.log(`    → Created subscription`);
                    subscriptionsCreated++;
                }

            } catch (error) {
                console.error(`    ✗ Error processing ${row.platform} - ${row.username}:`, error.message);
                errors.push({
                    streamer: `${row.platform} - ${row.username}`,
                    error: error.message
                });
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('MIGRATION SUMMARY');
        console.log('='.repeat(80));
        console.log(`Total subscriptions processed: ${sourceData.length}`);
        console.log(`\nStreamers:`);
        console.log(`  - Created: ${streamersCreated}`);
        console.log(`  - Already existed: ${streamersExisting}`);
        console.log(`\nSubscriptions:`);
        console.log(`  - Created: ${subscriptionsCreated}`);
        console.log(`  - Already existed: ${subscriptionsExisting}`);

        if (errors.length > 0) {
            console.log(`\n⚠️  Errors: ${errors.length}`);
            errors.forEach(err => {
                console.log(`  - ${err.streamer}: ${err.error}`);
            });
        }

        console.log('='.repeat(80) + '\n');

    } catch (error) {
        console.error('\n✗ Fatal error during migration:', error);
        throw error;
    } finally {
        if (livenotifConn) await livenotifConn.end();
        if (utilityConn) await utilityConn.end();
    }
}

// Run migration
migrateStreamers()
    .then(() => {
        console.log('✅ Migration completed successfully!');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    });
