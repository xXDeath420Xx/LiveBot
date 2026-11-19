import pool from '../utils/db.js';
import { up } from '../migrations/371_twitch_tier_b_round_two.js';
try { await up(pool); console.log('migration 371 applied'); process.exit(0); }
catch (e) { console.error('migration 371 failed:', e.message, e.stack); process.exit(1); }
