import 'dotenv/config';
import mysql from 'mysql2/promise';
import { up } from '../migrations/237_tiktok_caption_routing.js';
const db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
try { await up(db); console.log('migration 237 applied'); }
catch (e) { console.error('FAILED', e.message); } finally { await db.end(); }
process.exit(0);
