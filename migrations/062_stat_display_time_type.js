/**
 * Migration 062: Add 'time' stat type to stat_display_channels
 * Shows the server owner's local time (date + time) based on guild timezone setting.
 */

export async function up(db) {
    await db.execute(`
        ALTER TABLE stat_display_channels
        MODIFY COLUMN stat_type ENUM('members', 'humans', 'bots', 'online', 'channels', 'roles', 'boosts', 'time') NOT NULL
    `);
    // Remove the unique_guild_stat constraint so multiple time channels or stat channels of the same type can exist
    // (e.g. a guild might want both a date channel and a time channel)
    try {
        await db.execute('ALTER TABLE stat_display_channels DROP INDEX unique_guild_stat');
    } catch { /* index may not exist */ }
    console.log('[Migration 062] Added time stat type to stat_display_channels');
}

export async function down(db) {
    await db.execute(`
        ALTER TABLE stat_display_channels
        MODIFY COLUMN stat_type ENUM('members', 'humans', 'bots', 'online', 'channels', 'roles', 'boosts') NOT NULL
    `);
    console.log('[Migration 062] Removed time stat type');
}
