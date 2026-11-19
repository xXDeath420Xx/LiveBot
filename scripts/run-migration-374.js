import pool from '../utils/db.js';
import { up } from '../migrations/374_twitch_peer_pool.js';
try { await up(pool); console.log('migration 374 applied'); process.exit(0); }
catch (e) { console.error('migration 374 failed:', e.message, e.stack); process.exit(1); }
