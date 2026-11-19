import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/227_vault_burn_and_minutes.js';
try { await up(pool); console.log('migration 227 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
