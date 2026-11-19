import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/383_twitch_full_capture.js';
try { await up(pool); console.log('migration 383 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
