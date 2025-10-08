const db = require('./utils/db');
const apiChecks = require('./utils/api_checks');
const initCycleTLS = require('cycletls');

async function fixMissingPlatformIds() {
    console.log('[MIGRATE] Starting data migration script...');

    let cycleTLS = null;

    try {
        const [streamersToFix] = await db.execute(
            'SELECT streamer_id, platform, username FROM streamers WHERE platform_user_id IS NULL OR platform_user_id = ""'
        );

        if (streamersToFix.length === 0) {
            console.log('[MIGRATE] No streamers found with missing platform_user_id. Database is likely already up to date.');
            return;
        }

        console.log(`[MIGRATE] Found ${streamersToFix.length} streamer(s) to fix...`);
        let fixedCount = 0;
        let failedCount = 0;

        const needsCycleTLS = streamersToFix.some(s => s.platform === 'kick');
        if (needsCycleTLS) {
            try {
                cycleTLS = await initCycleTLS({ timeout: 60000 });
                console.log('[MIGRATE] cycleTLS initialized for Kick platform.');
            } catch (cycleTLSError) {
                console.error('[MIGRATE] Error initializing cycleTLS. Kick platform IDs may not be fixable:', cycleTLSError.message);
                // Continue without cycleTLS, Kick platform IDs will likely fail.
            }
        }

        for (const streamer of streamersToFix) {
            console.log(`[MIGRATE] > Processing ${streamer.username} on ${streamer.platform}...`);
            let puid = null;

            try {
                if (streamer.platform === 'kick') {
                    if (cycleTLS) {
                        const kickUser = await apiChecks.getKickUser(cycleTLS, streamer.username);
                        if (kickUser && kickUser.id) {
                            puid = kickUser.id.toString();
                        }
                    } else {
                        console.log(`[MIGRATE]   ❌ SKIPPED: Kick platform ID for ${streamer.username} because cycleTLS failed to initialize.`);
                    }
                } else if (streamer.platform === 'twitch') {
                    const twitchUser = await apiChecks.getTwitchUser(streamer.username);
                    if (twitchUser && twitchUser.id) {
                        puid = twitchUser.id;
                    }
                } else if (streamer.platform === 'youtube') {
                    const youtubeChannelId = await apiChecks.getYouTubeChannelId(streamer.username);
                    if (youtubeChannelId) {
                        puid = youtubeChannelId;
                    }
                }
            } catch (apiError) {
                console.log(`[MIGRATE]   ❌ FAILED API Call for ${streamer.username} on ${streamer.platform}: ${apiError.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, 250));

            if (puid) {
                await db.execute(
                    'UPDATE streamers SET platform_user_id = ? WHERE streamer_id = ?',
                    [puid, streamer.streamer_id]
                );
                console.log(`[MIGRATE]   ✔️ SUCCESS: Updated ${streamer.username} with ID: ${puid}`);
                fixedCount++;
            } else {
                console.log(`[MIGRATE]   ❌ FAILED: Could not find platform ID for ${streamer.username} on ${streamer.platform}. Please check the username.`);
                failedCount++;
            }
        }

        console.log('[MIGRATE] --- Migration Complete ---');
        console.log(`[MIGRATE] ${fixedCount} records successfully updated.`);
        console.log(`[MIGRATE] ${failedCount} records failed. Manual review may be needed.`);

    } catch (error) {
        console.error('[MIGRATE] A critical error occurred during migration:', error);
    } finally {
        if (cycleTLS) {
            try { cycleTLS.exit(); } catch(e){ console.error('[MIGRATE] Error exiting cycleTLS:', e); }
        }
        if (db) {
            try { await db.end(); } catch(e){ console.error('[MIGRATE] Error closing database connection:', e); }
        }
    }
}

fixMissingPlatformIds();