import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/393_chat_samples_retention.js';
try { await up(pool); console.log('migration 393 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
