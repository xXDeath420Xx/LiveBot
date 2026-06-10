import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/125_kbd_channel_settings.js';

(async () => {
    try {
        await up(pool);
        const [t] = await pool.execute("SHOW TABLES LIKE 'kbd_channel_settings'");
        console.log('Migration 125 — kbd_channel_settings present:', t.length === 1);
    } catch (e) {
        console.error('Migration 125 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
