import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/223_question_field_label.js';

try {
  await up(pool);
  console.log('migration 223 applied');
} catch (err) {
  console.error('FAILED:', err.message);
}
process.exit(0);
