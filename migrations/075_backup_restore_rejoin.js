export async function up(db) {
    await db.execute(`
        ALTER TABLE guild_settings
        ADD COLUMN backup_restore_data LONGTEXT DEFAULT NULL,
        ADD COLUMN backup_restore_expires DATETIME DEFAULT NULL
    `);
}

export async function down(db) {
    await db.execute('ALTER TABLE guild_settings DROP COLUMN backup_restore_data, DROP COLUMN backup_restore_expires');
}
