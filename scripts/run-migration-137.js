import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/137_epic_sprite_share.js';
(async () => {
    try {
        await up(pool);
        const [c] = await pool.execute("SHOW COLUMNS FROM epic_sprite_accounts LIKE 'share_id'");
        console.log('Migration 137 — epic_sprite_accounts.share_id present:', c.length === 1);
    } catch (e) { console.error('Migration 137 FAILED:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
