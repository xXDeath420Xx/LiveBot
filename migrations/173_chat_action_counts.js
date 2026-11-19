export async function up(db) {
    // Generalise the hug counter: same shape, plus an `action` so !dropkick (and whatever
    // comes next) share one table and one endpoint instead of a table per command.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS chat_action_counts (
            channel VARCHAR(64) NOT NULL,
            action VARCHAR(32) NOT NULL,
            username VARCHAR(64) NOT NULL,
            count INT UNSIGNED NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (channel, action, username)
        )
    `);

    // Carry over anything already counted by the hug-only table (migration 172)
    const [tables] = await db.execute("SHOW TABLES LIKE 'hug_counts'");
    if (tables.length) {
        await db.execute(`
            INSERT INTO chat_action_counts (channel, action, username, count)
            SELECT channel, 'hug', username, hugs FROM hug_counts
            ON DUPLICATE KEY UPDATE count = GREATEST(chat_action_counts.count, VALUES(count))
        `);
        await db.execute('DROP TABLE hug_counts');
    }

    console.log('[Migration 173] Created chat_action_counts and folded hug_counts into it');
}

export async function down(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS hug_counts (
            channel VARCHAR(64) NOT NULL,
            username VARCHAR(64) NOT NULL,
            hugs INT UNSIGNED NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (channel, username)
        )
    `);
    await db.execute(`
        INSERT INTO hug_counts (channel, username, hugs)
        SELECT channel, username, count FROM chat_action_counts WHERE action = 'hug'
        ON DUPLICATE KEY UPDATE hugs = VALUES(hugs)
    `);
    await db.execute('DROP TABLE chat_action_counts');
    console.log('[Migration 173] Restored hug_counts');
}
