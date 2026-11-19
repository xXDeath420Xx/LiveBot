import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/387_twitch_collation_all.js';
try { await up(pool); console.log('migration 387 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
