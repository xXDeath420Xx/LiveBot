export async function up(db) {
    await db.execute(`
        ALTER TABLE live_announcements ADD COLUMN ping_message_id VARCHAR(255) DEFAULT NULL
    `);
}

export async function down(db) {
    await db.execute('ALTER TABLE live_announcements DROP COLUMN ping_message_id');
}
