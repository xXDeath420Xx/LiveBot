import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/390_known_bot_checks.js';
try { await up(pool); console.log('migration 390 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
