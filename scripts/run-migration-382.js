import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/382_twitch_collation_normalize.js';
try { await up(pool); console.log('migration 382 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
