import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/218_form_builder.js';

try {
  await up(pool);
  console.log('migration 218 applied');
} catch (err) {
  console.error('FAILED:', err.message);
}
process.exit(0);
