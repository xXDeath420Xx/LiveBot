import pool from '../utils/db.js';
import { up } from '../migrations/366_twitch_broadcaster_backfill.js';

try {
    await up(pool);
    console.log('migration 366 applied');
    process.exit(0);
} catch (e) {
    console.error('migration 366 failed:', e.message);
    console.error(e.stack);
    process.exit(1);
}
