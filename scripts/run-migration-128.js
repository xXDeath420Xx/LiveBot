import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/128_kick_timers.js';
(async () => {
    try {
        await up(pool);
        const [t] = await pool.execute("SHOW TABLES LIKE 'tokes_timers'");
        console.log('Migration 128 — tokes_timers present:', t.length === 1);
    } catch (e) { console.error('Migration 128 FAILED:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
