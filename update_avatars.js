const db = require('./utils/db');
const apiChecks = require('./utils/api_checks');
const initCycleTLS = require('cycletls');

async function migrateAvatars() {
    console.log('[MIGRATE] Starting avatar migration script...');
    let cycleTLS = null;

    try {
        const [streamers] = await db.execute('SELECT streamer_id, platform, username, platform_user_id FROM streamers');
        if (streamers.length === 0) {
            console.log('[MIGRATE] No streamers found in the database. Exiting.');
            return;
        }

        console.log(`[MIGRATE] Found ${streamers.length} streamer(s) to process...`);
        let updatedCount = 0;
        
        const needsCycleTLS = streamers.some(s => s.platform === 'kick');
        if (needsCycleTLS) {
            try {
                cycleTLS = await initCycleTLS({ timeout: 60000 });
                console.log('[MIGRATE] cycleTLS initialized for Kick platform.');
            } catch (cycleTLSError) {
                console.error('[MIGRATE] Error initializing cycleTLS. Kick platform avatars may not be updateable:', cycleTLSError.message);
                // Continue without cycleTLS, Kick platform avatars will likely fail.
            }
        }

        for (const streamer of streamers) {
            let profileImageUrl = null;
            try {
                if (streamer.platform === 'twitch') {
                    const twitchUser = await apiChecks.getTwitchUser(streamer.platform_user_id);
                    if (twitchUser) profileImageUrl = twitchUser.profile_image_url;
                } else if (streamer.platform === 'kick') {
                    if (cycleTLS) {
                        const kickUser = await apiChecks.getKickUser(cycleTLS, streamer.username);
                        if (kickUser) profileImageUrl = kickUser.user.profile_pic;
                    } else {
                        console.log(`[MIGRATE]   ❌ SKIPPED: Kick avatar for ${streamer.username} because cycleTLS failed to initialize.`);
                    }
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
                 await new Promise(resolve => setTimeout(resolve, 250));
            } catch (e) {
                console.error(`[MIGRATE]  ❌  Error processing ${streamer.username}: ${e.message}`);
            }
        }
        
        console.log(`[MIGRATE] --- Migration Complete ---`);
        console.log(`[MIGRATE] Successfully updated ${updatedCount} avatars.`);

    } catch (error) {
        console.error('[MIGRATE] A critical error occurred during avatar migration:', error);
    } finally {
        if (cycleTLS) {
            try { cycleTLS.exit(); } catch(e){ console.error('[MIGRATE] Error exiting cycleTLS:', e); }
        }
        if (db) {
            try { await db.end(); } catch(e){ console.error('[MIGRATE] Error closing database connection:', e); }
        }
    }
}

migrateAvatars();