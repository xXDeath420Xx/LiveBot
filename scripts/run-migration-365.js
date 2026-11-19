import pool from '../utils/db.js';
import { up } from '../migrations/365_network_intel.js';

try {
    await up(pool);
    console.log('migration 365 applied');
    process.exit(0);
} catch (e) {
    console.error('migration 365 failed:', e.message);
    console.error(e.stack);
    process.exit(1);
}
