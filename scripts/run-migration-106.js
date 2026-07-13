import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/106_cah_winner_tracking.js';

(async () => {
    try {
        await up(pool);
        const [[r]] = await pool.execute(
            "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cah_games' AND column_name = 'winner_user_ids'"
        );
        console.log(`Migration 106 applied — winner_user_ids column: ${r.n === 1 ? 'OK' : 'MISSING'}`);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
