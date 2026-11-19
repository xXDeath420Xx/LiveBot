import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/210_member_purge.js';
(async () => {
    try {
        await up(pool);
        for (const t of ['member_purge_config', 'member_purge_jobs']) {
            const [c] = await pool.execute(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`, [t]);
            console.log(`${t}:`, c.map(x => x.column_name || x.COLUMN_NAME).join(', ') || '(missing)');
            if (!c.length) process.exitCode = 1;
        }
    } catch (e) { console.error('Migration 210 FAILED:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
