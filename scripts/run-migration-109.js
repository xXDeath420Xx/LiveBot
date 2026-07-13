import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/109_lobby_password.js';

(async () => {
    try {
        await up(pool);
        const [[r]] = await pool.execute(`SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='cah_games' AND column_name='password_hash'`);
        console.log(`Migration 109 — password_hash: ${r.n === 1 ? 'OK' : 'MISSING'}`);
    } catch (err) { console.error('Migration failed:', err); process.exitCode = 1; }
    finally { await pool.end(); }
})();
