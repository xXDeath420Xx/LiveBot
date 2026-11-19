import pool from '../utils/db.js';
import { up } from '../migrations/369_twitch_analytics_tier_a.js';
try { await up(pool); console.log('migration 369 applied'); process.exit(0); }
catch (e) { console.error('migration 369 failed:', e.message, e.stack); process.exit(1); }
