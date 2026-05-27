import pool from '../utils/db.js';
import { up } from '../migrations/113_fourthwall_shop_tracker.js';
try {
  await up(pool);
  const [r] = await pool.execute("SHOW TABLES LIKE 'fourthwall_tracked_%'");
  console.log('OK tables:', r.length);
  for (const row of r) console.log(' -', Object.values(row)[0]);
  process.exit(0);
} catch (e) { console.error('FAIL:', e.message); process.exit(1); }
