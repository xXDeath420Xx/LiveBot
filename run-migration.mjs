import { createPool } from 'mysql2/promise';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const pool = createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: true
});

try {
  const sql = readFileSync('/root/discord_bots/CertiFriedUtility/migrations/018_rpg_core_system.sql', 'utf8');
  console.log('Running RPG core system migration...');

  await pool.query(sql);

  console.log('✓ Migration 018 complete');

  // Run seed data migrations
  const seed1 = readFileSync('/root/discord_bots/CertiFriedUtility/migrations/019_rpg_seed_data.sql', 'utf8');
  console.log('Running RPG seed data v1...');
  await pool.query(seed1);
  console.log('✓ Seed data v1 complete');

  const seed2 = readFileSync('/root/discord_bots/CertiFriedUtility/migrations/019_rpg_seed_data_v2.sql', 'utf8');
  console.log('Running RPG seed data v2...');
  await pool.query(seed2);
  console.log('✓ Seed data v2 complete');

  await pool.end();
  console.log('\nAll RPG migrations complete!');
} catch (err) {
  console.error('Migration error:', err.message);
  process.exit(1);
}
