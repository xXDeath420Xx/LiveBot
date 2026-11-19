import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/205_credential_relink_state.js';

(async () => {
    try {
        await up(pool);

        const [ig] = await pool.execute(
            `SELECT ig_user_id, ig_username, token_type, needs_relink, token_expires_at
             FROM instagram_links ORDER BY token_expires_at`);
        for (const r of ig) {
            console.log(`Migration 205 — instagram ${r.ig_user_id} (@${r.ig_username || '?'}): `
                + `type=${r.token_type} needs_relink=${r.needs_relink} expires=${r.token_expires_at?.toISOString?.() || r.token_expires_at}`);
        }

        const [kick] = await pool.execute(
            `SELECT id, platform_name, needs_relink, expires_at
             FROM tokes_platform_connections WHERE platform = 'kick' ORDER BY expires_at`);
        for (const r of kick) {
            console.log(`Migration 205 — kick #${r.id} (${r.platform_name}): `
                + `needs_relink=${r.needs_relink} expires=${r.expires_at?.toISOString?.() || r.expires_at}`);
        }

        const igStuck = ig.filter(r => r.needs_relink).length;
        const kickStuck = kick.filter(r => r.needs_relink).length;
        console.log(`Migration 205 — flagged ${igStuck} Instagram link(s) and ${kickStuck} Kick connection(s) as needing re-link.`);
    } catch (e) {
        console.error('Migration 205 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
