import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/219_remove_gamerpower.js';

try {
  await up(pool);
  console.log('migration 219 applied');
} catch (err) {
  console.error('FAILED:', err.message);
}
process.exit(0);
