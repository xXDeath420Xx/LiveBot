import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/248_voice_captions_scriptly_parity.js';
try { await up(pool); console.log('migration 248 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
