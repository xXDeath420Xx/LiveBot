import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/108_user_authored_decks.js';

(async () => {
    try {
        await up(pool);
        const [[a]] = await pool.execute(`SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='cah_decks' AND column_name='owner_user_id'`);
        const [[b]] = await pool.execute(`SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='cah_decks' AND column_name='is_public'`);
        console.log(`Migration 108 — owner_user_id: ${a.n === 1 ? 'OK' : 'MISSING'}, is_public: ${b.n === 1 ? 'OK' : 'MISSING'}`);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
