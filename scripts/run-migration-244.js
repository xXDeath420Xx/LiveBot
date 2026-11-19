import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/244_form_dm_on_submit.js';
try { await up(pool); console.log('migration 244 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
