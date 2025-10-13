const db = require('./utils/db');
const twitchApi = require('./utils/twitch-api');
const kickApi = require('./utils/kick-api');
const { getYouTubeChannelId } = require('./utils/api_checks');
const { exitCycleTLSInstance } = require('./utils/tls-manager'); // Corrected import

async function fixMissingPlatformIds() {
    console.log('[MIGRATE] Starting data migration script...');

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

        for (const streamer of streamersToFix) {
            console.log(`[MIGRATE] > Processing ${streamer.username} on ${streamer.platform}...`);
            let puid = null;

            try {
                if (streamer.platform === 'kick') {
                    const kickUser = await kickApi.getKickUser(streamer.username);
                    if (kickUser && kickUser.id) {
                        puid = kickUser.id.toString();
                    }
                } else if (streamer.platform === 'twitch') {
                    const twitchUser = await twitchApi.getTwitchUser(streamer.username);
                    if (twitchUser && twitchUser.id) {
                        puid = twitchUser.id;
                    }
                } else if (streamer.platform === 'youtube') {
                    const youtubeChannel = await getYouTubeChannelId(streamer.username);
                    if (youtubeChannel?.channelId) {
                        puid = youtubeChannel.channelId;
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
        await exitCycleTLSInstance();
        if (db) {
            try { await db.end(); } catch(e){ console.error('[MIGRATE] Error closing database connection:', e); }
        }
    }
}

fixMissingPlatformIds();