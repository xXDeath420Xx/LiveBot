import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/386_chatter_message_counts.js';
try { await up(pool); console.log('migration 386 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
