import { createPool } from 'mysql2/promise';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const pool = createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: true
});

try {
  const sql = readFileSync('/tmp/create-security-tables.sql', 'utf8');
  console.log('Creating security tables...');

  await pool.query(sql);

  console.log('✓ Security tables created successfully!');

  // Verify tables exist
  const [tables] = await pool.execute(`
    SHOW TABLES LIKE '%config'
  `);

  console.log('\nSecurity config tables:');
  tables.forEach(table => {
    const tableName = Object.values(table)[0];
    if (tableName.includes('anti_raid') || tableName.includes('anti_nuke') || tableName.includes('join_gate')) {
      console.log(' ✓', tableName);
    }
  });

  await pool.end();
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
