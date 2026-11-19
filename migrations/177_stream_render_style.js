/**
 * Per-scope live-announcement render style.
 *
 * Two ways to draw a "X is live" post:
 *   'twitch' — the platform's own live preview hotlinked into the embed, with the streamer's
 *              avatar as the embed thumbnail. What the unified community channel has always
 *              done (jobs/cross-network-scheduler.js) and what most people picture when they
 *              think of a Twitch embed. Default.
 *   'card'   — the card we render ourselves (utils/stream-card.js) and upload as stream.png.
 *              Consistent across platforms and immune to CDN/proxy trouble, but it is our
 *              layout, not Twitch's.
 *
 * Resolution is most-specific-wins: streamer → channel → guild → 'twitch'. That gives both
 * halves of the ask — a whole channel can be set one way while one streamer inside it differs.
 *
 * scope_id holds a channel id or a streamer id; for the guild-wide row it is '' (empty rather
 * than NULL so it can sit in the primary key).
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS stream_render_style (
            guild_id VARCHAR(20) NOT NULL,
            scope_type ENUM('guild','channel','streamer') NOT NULL,
            scope_id VARCHAR(64) NOT NULL DEFAULT '',
            style ENUM('twitch','card') NOT NULL DEFAULT 'twitch',
            updated_by VARCHAR(20) DEFAULT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, scope_type, scope_id),
            INDEX idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS stream_render_style');
}
