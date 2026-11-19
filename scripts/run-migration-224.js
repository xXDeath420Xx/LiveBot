import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/224_form_sessions.js';
try { await up(pool); console.log('migration 224 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
