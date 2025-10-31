const { db } = require('./utils/db');
const twitchApi = require('./utils/twitch-api');
const kickApi = require('./utils/kick-api');
const { exitCycleTLSInstance } = require('./utils/tls-manager'); // Corrected import

async function migrateAvatars() {
    console.log('[MIGRATE] Starting avatar migration script...');

    try {
        const [streamers] = await db.execute('SELECT streamer_id, platform, username, platform_user_id FROM streamers');
        if (streamers.length === 0) {
            console.log('[MIGRATE] No streamers found in the database. Exiting.');
            return;
        }

        console.log(`[MIGRATE] Found ${streamers.length} streamer(s) to process...`);
        let updatedCount = 0;

        for (const streamer of streamers) {
            let profileImageUrl = null;
            try {
                if (streamer.platform === 'twitch') {
                    const twitchUser = await twitchApi.getTwitchUser(streamer.username);
                    if (twitchUser) profileImageUrl = twitchUser.profile_image_url;
                } else if (streamer.platform === 'kick') {
                    const kickUser = await kickApi.getKickUser(streamer.username);
                    if (kickUser) profileImageUrl = kickUser.user.profile_pic;
                }
                
                if (profileImageUrl) {
                    await db.execute(
                        'UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?',
                        [profileImageUrl, streamer.streamer_id]
                    );
                    console.log(`[MIGRATE]  ✔️  Updated avatar for ${streamer.username} (${streamer.platform})`);
                    updatedCount++;
                } else {
                    console.log(`[MIGRATE]  ⚠️  Could not find avatar for ${streamer.username} (${streamer.platform}). Skipping.`);
                }
                 await new Promise(resolve => setTimeout(resolve, 250)); // Rate limit to be safe
            } catch (e) {
                console.error(`[MIGRATE]  ❌  Error processing ${streamer.username}: ${e.message}`);
            }
        }
        
        console.log(`[MIGRATE] --- Migration Complete ---`);
        console.log(`[MIGRATE] Successfully updated ${updatedCount} avatars.`);

    } catch (error) {
        console.error('[MIGRATE] A critical error occurred during avatar migration:', error);
    } finally {
        // Clean up shared resources
        await exitCycleTLSInstance();
        if (db) {
            try { await db.end(); } catch(e){ console.error('[MIGRATE] Error closing database connection:', e); }
        }
    }
}

migrateAvatars();