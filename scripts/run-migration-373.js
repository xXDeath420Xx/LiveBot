import pool from '../utils/db.js';
import { up } from '../migrations/373_twitch_ai_final.js';
try { await up(pool); console.log('migration 373 applied'); process.exit(0); }
catch (e) { console.error('migration 373 failed:', e.message, e.stack); process.exit(1); }
