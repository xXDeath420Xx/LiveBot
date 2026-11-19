import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/207_qotd_library.js';

(async () => {
    try {
        await up(pool);
        const [lib] = await pool.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'qotd_library' ORDER BY ordinal_position`);
        const [hist] = await pool.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'qotd_history'
               AND column_name IN ('library_id','variant_group','theme')`);
        const [chan] = await pool.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'qotd_channels'
               AND column_name IN ('source_mode','repeat_window_days','cross_guild_spacing_days','theme_blocklist')`);
        const name = r => r.column_name || r.COLUMN_NAME;
        console.log('qotd_library:', lib.map(name).join(', ') || '(missing)');
        console.log('qotd_history +:', hist.map(name).join(', '));
        console.log('qotd_channels +:', chan.map(name).join(', '));
        if (!lib.length || hist.length !== 3 || chan.length !== 4) {
            console.error('Migration 207 — incomplete');
            process.exitCode = 1;
        }
    } catch (e) {
        console.error('Migration 207 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
