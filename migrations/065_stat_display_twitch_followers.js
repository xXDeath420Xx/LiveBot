export async function up(db) {
    await db.execute(`
        ALTER TABLE stat_display_channels
        MODIFY COLUMN stat_type ENUM('members', 'humans', 'bots', 'online', 'channels', 'roles', 'boosts', 'time', 'date', 'role', 'twitch_followers') NOT NULL
    `);
    console.log('[Migration 065] Added twitch_followers stat type');
}

export async function down(db) {
    await db.execute(`
        ALTER TABLE stat_display_channels
        MODIFY COLUMN stat_type ENUM('members', 'humans', 'bots', 'online', 'channels', 'roles', 'boosts', 'time', 'date', 'role') NOT NULL
    `);
    console.log('[Migration 065] Removed twitch_followers stat type');
}
