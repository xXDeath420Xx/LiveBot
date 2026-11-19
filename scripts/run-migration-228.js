import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/228_throne_item_name_length.js';
try { await up(pool); console.log('migration 228 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
