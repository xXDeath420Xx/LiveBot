import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/107_manydecks_source.js';

(async () => {
    try {
        await up(pool);
        const [[s]] = await pool.execute(
            `SELECT column_type FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='cah_decks' AND column_name='source'`
        );
        const [[idx]] = await pool.execute(
            `SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='cah_decks' AND index_name='uq_source_cast'`
        );
        console.log(`Migration 107 — source enum: ${s.column_type}`);
        console.log(`Composite unique index uq_source_cast: ${idx.n > 0 ? 'OK' : 'MISSING'}`);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
