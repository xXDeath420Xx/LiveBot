import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/127_kick_auto_responders.js';

(async () => {
    try {
        await up(pool);
        const [t] = await pool.execute("SHOW TABLES LIKE 'tokes_auto_responders'");
        console.log('Migration 127 — tokes_auto_responders present:', t.length === 1);
    } catch (e) {
        console.error('Migration 127 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
