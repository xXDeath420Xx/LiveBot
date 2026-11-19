export async function up(db) {
    // Live embeds were rewritten every 5 minutes whether or not anything had changed.
    // Remember what we last rendered so an unchanged stream costs no Discord edit at all.
    await db.execute(`ALTER TABLE live_announcements ADD COLUMN last_title VARCHAR(512) DEFAULT NULL`);
    await db.execute(`ALTER TABLE live_announcements ADD COLUMN last_game VARCHAR(255) DEFAULT NULL`);

    console.log('[Migration 171] Added live_announcements.last_title / last_game for change-detected embed updates');
}

export async function down(db) {
    await db.execute(`ALTER TABLE live_announcements DROP COLUMN last_title`);
    await db.execute(`ALTER TABLE live_announcements DROP COLUMN last_game`);
    console.log('[Migration 171] Dropped last_title / last_game');
}
