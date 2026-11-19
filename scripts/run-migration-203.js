import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/203_remove_trovo.js';

(async () => {
    try {
        const [before] = await pool.execute(
            `SELECT
               (SELECT COUNT(*) FROM streamers WHERE platform='trovo') AS streamers,
               (SELECT COUNT(*) FROM subscriptions s JOIN streamers st ON st.streamer_id=s.streamer_id
                 WHERE st.platform='trovo') AS subs,
               (SELECT COUNT(*) FROM live_announcements WHERE platform='trovo') AS announcements,
               (SELECT COUNT(*) FROM self_promo_config WHERE allowed_platforms LIKE '%trovo%') AS selfpromo`,
        );
        console.log('Migration 203 — before:', before[0]);

        await up(pool);

        const [after] = await pool.execute(
            `SELECT
               (SELECT COUNT(*) FROM streamers WHERE platform='trovo') AS streamers,
               (SELECT COUNT(*) FROM subscriptions s JOIN streamers st ON st.streamer_id=s.streamer_id
                 WHERE st.platform='trovo') AS subs,
               (SELECT COUNT(*) FROM live_announcements WHERE platform='trovo') AS announcements,
               (SELECT COUNT(*) FROM self_promo_config WHERE allowed_platforms LIKE '%trovo%') AS selfpromo`,
        );
        console.log('Migration 203 — after: ', after[0]);

        const leftover = Object.values(after[0]).reduce((a, b) => a + Number(b), 0);
        if (leftover !== 0) {
            console.error('Migration 203 — expected 0 Trovo rows remaining, found', leftover);
            process.exitCode = 1;
        } else {
            console.log('Migration 203 — Trovo fully retired.');
        }
    } catch (e) {
        console.error('Migration 203 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
