import pool from '../utils/db.js';
import { up } from '../migrations/375_twitch_transcripts_vision.js';
try { await up(pool); console.log('migration 375 applied'); process.exit(0); }
catch (e) { console.error('migration 375 failed:', e.message, e.stack); process.exit(1); }
