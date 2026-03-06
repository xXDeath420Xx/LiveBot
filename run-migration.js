import pool from './utils/db.js';
import fs from 'fs';

const sql = fs.readFileSync('./services/certifried-extension/database/migrations/add_phase1_features.sql', 'utf8');
const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 5);

for (const stmt of statements) {
  if (stmt.trim() && !stmt.startsWith('--')) {
    try {
      await pool.execute(stmt);
      console.log('OK:', stmt.substring(0, 50) + '...');
    } catch (e) {
      if (e.code === 'ER_TABLE_EXISTS_ERROR') {
        console.log('Exists:', stmt.substring(0, 40) + '...');
      } else {
        console.error('Error:', e.message);
      }
    }
  }
}
console.log('\nMigration complete!');
process.exit(0);
