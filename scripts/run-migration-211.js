import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/211_member_purge_progress.js';
(async () => {
    try {
        await up(pool);
        const [c] = await pool.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'member_purge_jobs' ORDER BY ordinal_position`);
        console.log('member_purge_jobs:', c.map(x => x.column_name || x.COLUMN_NAME).join(', '));
    } catch (e) { console.error('Migration 211 FAILED:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
