import { createPool } from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const pool = createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

try {
  // Check for RPG tables
  const [tables] = await pool.execute(`
    SHOW TABLES LIKE 'rpg%'
  `);

  console.log('RPG tables found:', tables.length);
  tables.forEach(table => {
    console.log(' -', Object.values(table)[0]);
  });

  // Check rpg_characters structure
  const [chars] = await pool.execute(`
    DESCRIBE rpg_characters
  `);

  console.log('\nrpg_characters columns:');
  chars.forEach(col => {
    console.log(` - ${col.Field} (${col.Type})`);
  });

  // Get sample character count for guild
  const [[stats]] = await pool.execute(`
    SELECT COUNT(*) as total,
           COUNT(DISTINCT user_id) as unique_users
    FROM rpg_characters
    WHERE guild_id = ?
  `, ['1404239197987930114']);

  console.log('\nStats for guild 1404239197987930114:');
  console.log(' - Total characters:', stats.total);
  console.log(' - Unique players:', stats.unique_users);

  await pool.end();
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
