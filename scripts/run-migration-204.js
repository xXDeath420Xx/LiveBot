import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/204_server_stats_columns.js';

(async () => {
    try {
        await up(pool);

        const [cols] = await pool.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'server_stats'
               AND column_name IN ('member_count', 'new_members', 'active_users')`,
        );
        console.log('Migration 204 — columns present:', cols.map(c => c.column_name || c.COLUMN_NAME).sort().join(', '));

        if (cols.length !== 3) {
            console.error('Migration 204 — expected 3 columns, found', cols.length);
            process.exitCode = 1;
            return;
        }

        // Prove the exact statement events/serverStats.js runs now succeeds, then undo it.
        await pool.execute(
            `INSERT INTO server_stats (guild_id, date, member_count, message_count, new_members, active_users)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE member_count = VALUES(member_count)`,
            ['__migration_204_probe__', '1970-01-01', 1, 2, 3, 4],
        );
        await pool.execute(`DELETE FROM server_stats WHERE guild_id = '__migration_204_probe__'`);
        console.log('Migration 204 — serverStats.js insert shape verified.');
    } catch (e) {
        console.error('Migration 204 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
