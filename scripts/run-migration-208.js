import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/208_activity_audits.js';

(async () => {
    try {
        await up(pool);
        for (const t of ['activity_audits', 'activity_audit_members']) {
            const [cols] = await pool.execute(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`, [t]);
            console.log(`${t}:`, cols.map(c => c.column_name || c.COLUMN_NAME).join(', ') || '(missing)');
            if (!cols.length) process.exitCode = 1;
        }
    } catch (e) {
        console.error('Migration 208 FAILED:', e.message);
        process.exitCode = 1;
    } finally { await pool.end(); }
})();
