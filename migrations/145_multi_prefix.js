// Multiple command prefixes per guild (!, ?, $, .) plus @mention, and a switch for
// reaching every slash command from chat.
async function hasColumn(db, table, column) {
  const [rows] = await db.execute(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]);
  return rows.length > 0;
}

export async function up(db) {
  if (!await hasColumn(db, 'prefix_command_config', 'prefixes')) {
    // NULL = fall back to DEFAULT_PREFIXES. The legacy `prefix` column stays the
    // primary prefix so existing guilds keep whatever they configured.
    await db.execute('ALTER TABLE prefix_command_config ADD COLUMN prefixes JSON NULL AFTER prefix');
  }
  if (!await hasColumn(db, 'prefix_command_config', 'allow_mention')) {
    await db.execute('ALTER TABLE prefix_command_config ADD COLUMN allow_mention TINYINT(1) NOT NULL DEFAULT 1 AFTER prefixes');
  }
  if (!await hasColumn(db, 'prefix_command_config', 'universal_commands')) {
    await db.execute('ALTER TABLE prefix_command_config ADD COLUMN universal_commands TINYINT(1) NOT NULL DEFAULT 1 AFTER allow_mention');
  }
}

export async function down(db) {
  for (const c of ['universal_commands', 'allow_mention', 'prefixes']) {
    if (await hasColumn(db, 'prefix_command_config', c)) {
      await db.execute(`ALTER TABLE prefix_command_config DROP COLUMN ${c}`);
    }
  }
}
