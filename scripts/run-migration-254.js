import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/254_fourtwenty_panels.js';
try { await up(pool); console.log('migration 254 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
