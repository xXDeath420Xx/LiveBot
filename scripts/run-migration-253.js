import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/253_voice_reader_spoken_names.js';
try { await up(pool); console.log('migration 253 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
