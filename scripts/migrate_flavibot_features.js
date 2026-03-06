import pool from '../utils/db.js';

async function runMigration() {
  try {
    console.log('Running FlaviBot-style features migration...');

    // Check what columns already exist in music_config
    const [columns] = await pool.execute(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'music_config'
    `);

    const existingColumns = columns.map(c => c.COLUMN_NAME);
    console.log('Existing columns:', existingColumns);

    // Add new columns if they don't exist
    const columnsToAdd = [
      { name: 'twenty_four_seven', type: 'BOOLEAN DEFAULT 0' },
      { name: 'default_voice_channel_id', type: 'VARCHAR(32) NULL' },
      { name: 'autoplay_enabled', type: 'BOOLEAN DEFAULT 0' },
      { name: 'autoplay_source', type: "VARCHAR(20) DEFAULT 'youtube'" },
      { name: 'request_channel_id', type: 'VARCHAR(32) NULL' },
      { name: 'vote_skip_enabled', type: 'BOOLEAN DEFAULT 0' },
      { name: 'vote_skip_percentage', type: 'INT DEFAULT 50' }
    ];

    for (const col of columnsToAdd) {
      if (!existingColumns.includes(col.name)) {
        console.log(`Adding column: ${col.name}`);
        await pool.execute(`ALTER TABLE music_config ADD COLUMN ${col.name} ${col.type}`);
        console.log(`  -> Added ${col.name}`);
      } else {
        console.log(`  Column ${col.name} already exists, skipping`);
      }
    }

    // Create music_permissions table if it doesn't exist
    console.log('\nCreating music_permissions table...');
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS music_permissions (
        guild_id VARCHAR(32) NOT NULL,
        role_id VARCHAR(32) NOT NULL,
        can_play BOOLEAN DEFAULT 1,
        can_skip BOOLEAN DEFAULT 1,
        can_stop BOOLEAN DEFAULT 0,
        can_volume BOOLEAN DEFAULT 1,
        can_filters BOOLEAN DEFAULT 0,
        can_clear BOOLEAN DEFAULT 0,
        can_247 BOOLEAN DEFAULT 0,
        can_forceskip BOOLEAN DEFAULT 0,
        PRIMARY KEY (guild_id, role_id)
      )
    `);
    console.log('  -> music_permissions table ready');

    console.log('\n✅ Migration completed successfully!');

    // Verify the changes
    const [newColumns] = await pool.execute(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'music_config'
    `);
    console.log('\nFinal music_config columns:', newColumns.map(c => c.COLUMN_NAME));

  } catch (error) {
    console.error('Migration error:', error);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

runMigration();
