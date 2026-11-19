import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/199_windrose_panel.js';

(async () => {
    try {
        await up(pool);
        // information_schema rather than `SHOW TABLES LIKE ?` — MariaDB rejects a
        // placeholder in SHOW, and inlining the name into the SQL is the habit
        // that turns into an injection the first time the value is not a literal.
        for (const t of ['windrose_users', 'windrose_audit', 'windrose_pending_config', 'windrose_backups']) {
            const [rows] = await pool.execute(
                'SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
                [t],
            );
            console.log(`Migration 199 — ${t} present:`, rows[0].c === 1);
        }

        // Seed the owner so the panel is reachable on first load. Without this
        // there is no row with a role above 'viewer' and nobody can grant one,
        // which locks the owner out of their own server.
        const ownerId = process.env.WINDROSE_OWNER_DISCORD_ID || process.env.BOT_OWNER_ID;
        if (ownerId) {
            await pool.execute(
                `INSERT INTO windrose_users (discord_id, role, display_name, granted_by)
                 VALUES (?, 'owner', 'owner (seeded)', 'migration-199')
                 ON DUPLICATE KEY UPDATE role = 'owner'`,
                [ownerId],
            );
            console.log('Migration 199 — seeded owner:', ownerId);
        } else {
            console.warn('Migration 199 — no WINDROSE_OWNER_DISCORD_ID or BOT_OWNER_ID set; no owner seeded');
        }
    } catch (e) {
        console.error('Migration 199 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
