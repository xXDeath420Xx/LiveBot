import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/114_kbd_tables.js';

(async () => {
    try {
        await up(pool);
        const [tables] = await pool.execute("SHOW TABLES LIKE 'kbd_%'");
        const [col] = await pool.execute("SHOW COLUMNS FROM tokes_channels LIKE 'defender_enabled'");
        console.log('Migration 114 — kbd_* tables:', tables.length, '/ defender_enabled col:', col.length);
        for (const row of tables) console.log(' -', Object.values(row)[0]);
    } catch (e) {
        console.error('Migration 114 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
