import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/394_schedule_custom_calendar.js';
try { await up(pool); console.log('migration 394 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
