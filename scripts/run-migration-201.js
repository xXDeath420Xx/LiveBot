import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/201_temp_access.js';

(async () => {
    try {
        await up(pool);
        // information_schema rather than `SHOW TABLES LIKE ?` — MariaDB rejects a
        // placeholder in SHOW.
        for (const t of ['temp_access_config', 'temp_access_invites', 'temp_access_members']) {
            const [rows] = await pool.execute(
                'SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
                [t],
            );
            console.log(`Migration 201 — ${t} present:`, rows[0].c === 1);
        }
    } catch (e) {
        console.error('Migration 201 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
