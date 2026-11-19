import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/363_holiday_countdowns.js';
try { await up(pool); console.log('migration 363 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
