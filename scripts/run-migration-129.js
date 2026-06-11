import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/129_kick_giveaways.js';
(async () => {
    try {
        await up(pool);
        const [t] = await pool.execute("SHOW TABLES LIKE 'tokes_giveaway%'");
        console.log('Migration 129 — giveaway tables present:', t.length === 2);
    } catch (e) { console.error('Migration 129 FAILED:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
