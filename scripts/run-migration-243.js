import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/243_form_tables_utf8mb4.js';
try { await up(pool); console.log('migration 243 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
