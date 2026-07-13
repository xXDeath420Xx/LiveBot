export async function up(db) {
    await db.execute(`
        ALTER TABLE prefix_command_config
        ADD COLUMN delete_trigger TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN cleanup_delay INT NOT NULL DEFAULT 0,
        ADD COLUMN private_categories JSON DEFAULT NULL
    `);
}

export async function down(db) {
    await db.execute(`
        ALTER TABLE prefix_command_config
        DROP COLUMN delete_trigger,
        DROP COLUMN cleanup_delay,
        DROP COLUMN private_categories
    `);
}
