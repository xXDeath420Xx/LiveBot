export async function up(db) {
    // Backs the StreamElements !hug counter (GET /api/hug).
    // (channel, username) is the PRIMARY KEY — that unique key is what makes the
    // endpoint's INSERT ... ON DUPLICATE KEY UPDATE increment instead of duplicating.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS hug_counts (
            channel VARCHAR(64) NOT NULL,
            username VARCHAR(64) NOT NULL,
            hugs INT UNSIGNED NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (channel, username)
        )
    `);

    console.log('[Migration 172] Created hug_counts');
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS hug_counts');
    console.log('[Migration 172] Dropped hug_counts');
}
