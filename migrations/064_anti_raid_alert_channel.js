export async function up(db) {
    await db.execute(`
        ALTER TABLE anti_raid_config
        ADD COLUMN alert_channel_id VARCHAR(20) DEFAULT NULL
    `);
    console.log('[Migration 064] Added alert_channel_id to anti_raid_config');
}

export async function down(db) {
    await db.execute('ALTER TABLE anti_raid_config DROP COLUMN alert_channel_id');
    console.log('[Migration 064] Removed alert_channel_id from anti_raid_config');
}
