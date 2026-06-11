import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/130_kick_chat_daily.js';
(async () => {
    try {
        await up(pool);
        const [t] = await pool.execute("SHOW TABLES LIKE 'tokes_chat_daily'");
        console.log('Migration 130 — tokes_chat_daily present:', t.length === 1);
    } catch (e) { console.error('Migration 130 FAILED:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
