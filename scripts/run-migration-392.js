import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/392_known_bot_autoban.js';
try { await up(pool); console.log('migration 392 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
