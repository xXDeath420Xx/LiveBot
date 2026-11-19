import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/202_stream_end_defaults.js';

(async () => {
    try {
        await up(pool);
        // information_schema rather than `SHOW COLUMNS LIKE ?` — MariaDB rejects a
        // placeholder in SHOW.
        const [rows] = await pool.execute(
            `SELECT column_name, column_default FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'guilds'
               AND column_name IN ('default_edit_on_end', 'default_delete_on_end')
             ORDER BY column_name`,
        );
        for (const r of rows) {
            console.log(`Migration 202 — guilds.${r.column_name || r.COLUMN_NAME} present, default ${r.column_default ?? r.COLUMN_DEFAULT}`);
        }
        if (rows.length !== 2) {
            console.error('Migration 202 — expected 2 columns, found', rows.length);
            process.exitCode = 1;
        }
    } catch (e) {
        console.error('Migration 202 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
