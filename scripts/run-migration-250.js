import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/250_announcement_posts.js';
try { await up(pool); console.log('migration 250 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
