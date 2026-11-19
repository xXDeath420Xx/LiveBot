import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/215_cross_channel_enforcement.js';

try {
  await up(pool);
  console.log('migration 215 applied');
} catch (err) {
  console.error('FAILED:', err.message);
}
process.exit(0);
