import pool from '../utils/db.js';
import { up } from '../migrations/364_holiday_auto_replies.js';

try {
    await up(pool);
    console.log('migration 364 applied');
    process.exit(0);
} catch (e) {
    console.error('migration 364 failed:', e.message);
    process.exit(1);
}
