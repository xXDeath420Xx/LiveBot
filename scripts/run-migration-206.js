import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/206_role_permission_notices.js';

(async () => {
    try {
        await up(pool);
        const [cols] = await pool.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'role_permission_notices'
             ORDER BY ordinal_position`);
        console.log('Migration 206 — role_permission_notices:',
            cols.map(c => c.column_name || c.COLUMN_NAME).join(', ') || '(missing)');
        if (cols.length === 0) {
            console.error('Migration 206 — table was not created');
            process.exitCode = 1;
        }
    } catch (e) {
        console.error('Migration 206 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
