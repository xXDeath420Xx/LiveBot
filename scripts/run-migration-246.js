import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/246_qotd_polls.js';
try { await up(pool); console.log('migration 246 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
