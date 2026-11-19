import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/385_cron_job_runs.js';
try { await up(pool); console.log('migration 385 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
