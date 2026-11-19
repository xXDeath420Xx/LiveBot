import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/384_snapshot_retention_90d.js';
try { await up(pool); console.log('migration 384 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
