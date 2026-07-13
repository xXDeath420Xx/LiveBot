export async function up(db) {
    await db.execute(`
        ALTER TABLE global_ban_entries
        ADD COLUMN reporter_name VARCHAR(100) DEFAULT NULL AFTER reporter_id
    `);
}

export async function down(db) {
    await db.execute(`
        ALTER TABLE global_ban_entries
        DROP COLUMN reporter_name
    `);
}
