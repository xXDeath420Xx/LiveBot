/**
 * One-shot: run the Helix backfill for WolfGangz's current connection so her analytics
 * page populates immediately, without waiting for her to disconnect/reconnect.
 *
 * Expected to be run with `node scripts/run-wolfgangz-backfill.mjs` from the server root.
 */
import pool from '../utils/db.js';
import { runBackfillFromConfig } from '../core/twitch-backfill.js';

const GUILD_ID = '1099732505243959407';

(async () => {
    try {
        const [[cfg]] = await pool.query(
            'SELECT broadcaster_twitch_id, broadcaster_twitch_username, token_scopes, token_expires_at FROM twitch_role_sync_config WHERE guild_id = ?',
            [GUILD_ID],
        );
        if (!cfg) {
            console.log('No role_sync_config for guild', GUILD_ID);
            process.exit(1);
        }
        console.log('Running backfill for', cfg.broadcaster_twitch_username, '(id', cfg.broadcaster_twitch_id + ')');
        console.log('Token expires:', cfg.token_expires_at);
        console.log('Scopes:', (cfg.token_scopes || '').split(/\s+/).filter(Boolean).length, 'granted');

        const started = Date.now();
        const result = await runBackfillFromConfig(GUILD_ID);
        const elapsed = Date.now() - started;

        console.log('\n=== RESULT ===');
        console.log('ok:', result.ok);
        console.log('duration_ms:', elapsed);
        console.log('counts:', JSON.stringify(result.counts, null, 2));
        if (Object.keys(result.errors || {}).length) {
            console.log('errors:');
            for (const [k, v] of Object.entries(result.errors)) {
                console.log(`  ${k}: status=${v.status || '-'} msg=${v.message}`);
            }
        }
        process.exit(result.ok ? 0 : 1);
    } catch (e) {
        console.error('FATAL:', e.message, e.stack);
        process.exit(1);
    }
})();
