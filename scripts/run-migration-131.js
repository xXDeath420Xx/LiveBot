import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/131_kick_events.js';
(async () => {
    try {
        await up(pool);
        const [t] = await pool.execute("SHOW TABLES LIKE 'tokes_kick_events'");
        console.log('Migration 131 — tokes_kick_events present:', t.length === 1);
    } catch (e) { console.error('Migration 131 FAILED:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
