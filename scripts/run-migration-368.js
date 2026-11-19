import pool from '../utils/db.js';
import { up } from '../migrations/368_twitch_analytics_pro.js';
try { await up(pool); console.log('migration 368 applied'); process.exit(0); }
catch (e) { console.error('migration 368 failed:', e.message, e.stack); process.exit(1); }
