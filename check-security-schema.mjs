import pool from './utils/db.js';

try {
  console.log('Checking security table schemas...\n');

  const tables = ['anti_raid_config', 'anti_nuke_config', 'join_gate_config'];

  for (const table of tables) {
    console.log(`\n${table}:`);
    const [columns] = await pool.execute(`DESCRIBE ${table}`);
    columns.forEach(col => {
      console.log(`  - ${col.Field} (${col.Type})`);
    });
  }

  await pool.end();
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
