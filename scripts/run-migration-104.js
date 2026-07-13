/**
 * One-shot runner for migration 104 (instagram_feeds + facebook_feeds tables).
 * Follows the pattern of scripts/run-migration-098.js since there is no
 * generic migrations/run.js in this repo.
 */
import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/104_instagram_facebook_feeds_tables.js';

(async () => {
    try {
        await up(pool);
        const [[ig]] = await pool.execute(
            "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'instagram_feeds'"
        );
        const [[fb]] = await pool.execute(
            "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'facebook_feeds'"
        );
        console.log(`Migration 104 applied — instagram_feeds:${ig.n === 1 ? 'OK' : 'MISSING'} facebook_feeds:${fb.n === 1 ? 'OK' : 'MISSING'}`);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
