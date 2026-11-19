import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/214_blocked_images.js';

try {
  await up(pool);
  console.log('migration 214 applied');
} catch (err) {
  console.error('FAILED:', err.message);
}
process.exit(0);
