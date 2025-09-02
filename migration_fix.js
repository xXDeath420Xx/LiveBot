// migration_fix.js
const db = require('./utils/db');
const apiChecks = require('./utils/api_checks');

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

            if (streamer.platform === 'kick') {
                const kickUser = await apiChecks.getKickUser(streamer.username);
                if (kickUser && kickUser.id) {
                    puid = kickUser.id.toString();
                }
            }
            // Add other platforms here if needed, e.g.,
            // else if (streamer.platform === 'trovo') { ... }

            if (puid) {
                await db.execute(
                    'UPDATE streamers SET platform_user_id = ? WHERE streamer_id = ?',
                    [puid, streamer.streamer_id]
                );
                console.log(`[MIGRATE]   ✔️ SUCCESS: Updated ${streamer.username} with ID: ${puid}`);
                fixedCount++;
            } else {
                console.log(`[MIGRATE]   ❌ FAILED: Could not find platform ID for ${streamer.username}. Please check the username.`);
                failedCount++;
            }
        }

        console.log('\n[MIGRATE] --- Migration Complete ---');
        console.log(`[MIGRATE] ${fixedCount} records successfully updated.`);
        console.log(`[MIGRATE] ${failedCount} records failed. Manual review may be needed.`);

    } catch (error) {
        console.error('[MIGRATE] A critical error occurred:', error);
    } finally {
        // Close the database connection pool
        await db.end();
    }
}

fixMissingPlatformIds();