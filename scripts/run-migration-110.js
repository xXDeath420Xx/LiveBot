import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/110_command_deploy_hash.js';
(async () => {
    try {
        await up(pool);
        const [[r]] = await pool.execute(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='command_deploy_hashes'`);
        console.log('Migration 110 — command_deploy_hashes:', r.n === 1 ? 'OK' : 'MISSING');
    } catch (e) { console.error(e); process.exitCode = 1; }
    finally { await pool.end(); }
})();
