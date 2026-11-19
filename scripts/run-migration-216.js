import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/216_streamer_departure_tracking.js';

try {
  await up(pool);
  console.log('migration 216 applied');
} catch (err) {
  console.error('FAILED:', err.message);
}
process.exit(0);
