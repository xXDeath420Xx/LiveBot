// One-off: scan streamers with temp_ platform_user_id placeholders, resolve the
// real id via each platform's API, and overwrite the temp_ value. Logs the result
// per row so you can see what got fixed and what couldn't be resolved (e.g. the
// user renamed on the platform too and the old username is now 404).
import { createPool } from './shared.js';
import { resolveStreamerIdentity } from '../../utils/platforms/resolve-identity.js';
import logger from '../../utils/logger.js';

const pool = createPool();

async function main() {
    const [rows] = await pool.execute(
        "SELECT streamer_id, platform, platform_user_id, username FROM streamers WHERE platform_user_id LIKE 'temp\\_%' ORDER BY streamer_id"
    );
    console.log('temp_ streamer rows to process:', rows.length);

    let fixed = 0, orphans = 0, skipped = 0;
    for (const r of rows) {
        const { streamer_id, platform, platform_user_id, username } = r;
        try {
            const identity = await resolveStreamerIdentity(platform, username);
            if (!identity) {
                console.log(`  [${streamer_id}] ${platform}:${username}  → NOT FOUND on platform (keeping temp_ for now, may need manual review)`);
                orphans++;
                continue;
            }

            // Check for collision with an existing row that already holds the real ID
            const [col] = await pool.execute(
                'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ? AND streamer_id != ?',
                [platform, identity.platformUserId, streamer_id]
            );
            if (col.length > 0) {
                // Another canonical row exists. Move this temp_ row's subscriptions over and delete it.
                const canonId = col[0].streamer_id;
                const [dupSubs] = await pool.execute('SELECT subscription_id, guild_id FROM subscriptions WHERE streamer_id = ?', [streamer_id]);
                const [canonSubs] = await pool.execute('SELECT guild_id FROM subscriptions WHERE streamer_id = ?', [canonId]);
                const canonGuilds = new Set(canonSubs.map(s => s.guild_id));
                let moved = 0, dropped = 0;
                for (const s of dupSubs) {
                    if (canonGuilds.has(s.guild_id)) {
                        await pool.execute('DELETE FROM subscriptions WHERE subscription_id = ?', [s.subscription_id]);
                        dropped++;
                    } else {
                        await pool.execute('UPDATE subscriptions SET streamer_id = ? WHERE subscription_id = ?', [canonId, s.subscription_id]);
                        moved++;
                    }
                }
                // Repoint live_announcements if that table stores streamer_id
                try {
                    await pool.execute('UPDATE live_announcements SET streamer_id = ? WHERE streamer_id = ?', [canonId, streamer_id]);
                } catch (e) { /* table may not have streamer_id col; ignore */ }
                await pool.execute('DELETE FROM streamers WHERE streamer_id = ?', [streamer_id]);
                console.log(`  [${streamer_id}→${canonId}] ${platform}:${username}  → MERGED into existing canonical row (moved=${moved}, dropped-dup=${dropped})`);
                fixed++;
                continue;
            }

            // No collision — just rewrite this row to the real identity
            await pool.execute(
                `UPDATE streamers SET
                    platform_user_id = ?,
                    username = ?,
                    profile_image_url = COALESCE(?, profile_image_url)
                 WHERE streamer_id = ?`,
                [identity.platformUserId, identity.canonicalUsername, identity.profileImageUrl || null, streamer_id]
            );
            console.log(`  [${streamer_id}] ${platform}:${username}  → UPGRADED to ${platform}:${identity.platformUserId} (${identity.canonicalUsername})`);
            fixed++;
        } catch (err) {
            console.log(`  [${streamer_id}] ${platform}:${username}  → ERROR ${err.message}`);
            skipped++;
        }
    }

    console.log(`\nDONE: fixed=${fixed}, orphans(still temp_)=${orphans}, errored=${skipped}`);
    await pool.end();
}

main().catch(err => { console.error('FATAL', err?.stack || err); process.exit(1); });
