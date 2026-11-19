import pool from '../utils/db.js';
import { up } from '../migrations/367_twitch_analytics_full.js';
try { await up(pool); console.log('migration 367 applied'); process.exit(0); }
catch (e) { console.error('migration 367 failed:', e.message, e.stack); process.exit(1); }
