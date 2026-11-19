import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/220_form_submission_identity.js';

try {
  await up(pool);
  console.log('migration 220 applied');
} catch (err) {
  console.error('FAILED:', err.message);
}
process.exit(0);
