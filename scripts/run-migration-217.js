import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/217_subscription_tracking_origin.js';

try {
  await up(pool);
  console.log('migration 217 applied');
} catch (err) {
  console.error('FAILED:', err.message);
}
process.exit(0);
