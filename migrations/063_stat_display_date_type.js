/**
 * Migration 063: Add 'date' stat type to stat_display_channels
 * Separate date and time display channels.
 */

export async function up(db) {
    await db.execute(`
        ALTER TABLE stat_display_channels
        MODIFY COLUMN stat_type ENUM('members', 'humans', 'bots', 'online', 'channels', 'roles', 'boosts', 'time', 'date') NOT NULL
    `);
    console.log('[Migration 063] Added date stat type to stat_display_channels');
}

export async function down(db) {
    await db.execute(`
        ALTER TABLE stat_display_channels
        MODIFY COLUMN stat_type ENUM('members', 'humans', 'bots', 'online', 'channels', 'roles', 'boosts', 'time') NOT NULL
    `);
    console.log('[Migration 063] Removed date stat type');
}
