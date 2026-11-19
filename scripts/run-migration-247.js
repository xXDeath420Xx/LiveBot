import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/247_voice_reader_transcription.js';
try { await up(pool); console.log('migration 247 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
