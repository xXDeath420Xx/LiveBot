import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/249_polls_nullable_ends_at.js';
try { await up(pool); console.log('migration 249 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
