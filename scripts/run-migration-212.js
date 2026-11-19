import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/212_member_purge_resume.js';
(async () => {
    try {
        await up(pool);
        const [c] = await pool.execute(
            `SELECT column_name, column_type FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'member_purge_jobs'
               AND column_name IN ('status','phase','done_channels','target_ids')`);
        for (const x of c) console.log(`  ${x.column_name || x.COLUMN_NAME}: ${x.column_type || x.COLUMN_TYPE}`);
    } catch (e) { console.error('Migration 212 FAILED:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
