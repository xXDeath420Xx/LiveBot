import pool from '../utils/db.js';
import { up } from '../migrations/376_anomaly_status.js';
try { await up(pool); console.log('migration 376 applied'); process.exit(0); }
catch (e) { console.error('migration 376 failed:', e.message, e.stack); process.exit(1); }
