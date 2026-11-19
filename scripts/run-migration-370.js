import pool from '../utils/db.js';
import { up } from '../migrations/370_twitch_tier_b.js';
try { await up(pool); console.log('migration 370 applied'); process.exit(0); }
catch (e) { console.error('migration 370 failed:', e.message, e.stack); process.exit(1); }
