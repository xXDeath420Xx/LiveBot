import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/225_panel_question_list.js';
try { await up(pool); console.log('migration 225 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
