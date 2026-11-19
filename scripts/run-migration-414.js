import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/414_audit_watcher_config.js';
try { await up(pool); console.log('migration 414 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
