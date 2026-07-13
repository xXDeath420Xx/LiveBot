/**
 * One-shot runner for migration 098 (temp_vc_multi_creator).
 * Project's migrations/run.js is missing, so we apply this single migration
 * directly via the shared db pool — same pattern other ad-hoc scripts use.
 */
import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/098_temp_vc_multi_creator.js';

(async () => {
    try {
        await up(pool);
        console.log('Migration 098 applied');
    } catch (err) {
        console.error('Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
