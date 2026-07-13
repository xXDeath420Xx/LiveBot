import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/136_epic_sprites.js';
(async () => {
    try {
        await up(pool);
        const [t] = await pool.execute("SHOW TABLES LIKE 'epic_sprite_accounts'");
        console.log('Migration 136 — epic_sprite_accounts present:', t.length === 1);
    } catch (e) { console.error('Migration 136 FAILED:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
