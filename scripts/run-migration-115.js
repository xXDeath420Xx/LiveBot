import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/115_kbd_link_offenses.js';

(async () => {
    try {
        await up(pool);
        const [t] = await pool.execute("SHOW TABLES LIKE 'kbd_link_offenses'");
        console.log('Migration 115 — kbd_link_offenses:', t.length === 1 ? 'OK' : 'MISSING');
    } catch (e) {
        console.error('Migration 115 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
