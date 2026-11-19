import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/245_channel_purge_rules.js';
try { await up(pool); console.log('migration 245 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
