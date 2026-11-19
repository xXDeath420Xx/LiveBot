/**
 * Subscriber live routing.
 *
 * Guilds that run a Twitch sub-only live channel (#subs-live) want a streamer who is
 * ALSO a subscriber of the server's Twitch channel announced there instead of in the
 * general live channels (#teammates-live / #stream-promo).
 *
 * Membership of the Discord Twitch-integration subscriber roles ("Twitch Subscriber:
 * Tier 1/2/3") is itself the proof that the member's Discord and Twitch accounts are
 * synced — Discord only grants those roles through the integration sync, so no extra
 * link check is needed.
 *
 * subscriber_role_ids NULL  = auto-detect the integration-managed subscriber roles.
 * source_channel_ids  NULL  = reroute out of ANY channel the announcement resolved to.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS guild_sub_live_routing (
            guild_id VARCHAR(20) PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            channel_id VARCHAR(20) NOT NULL,
            subscriber_role_ids TEXT DEFAULT NULL,
            source_channel_ids TEXT DEFAULT NULL,
            exclude_owner TINYINT(1) NOT NULL DEFAULT 1,
            excluded_user_ids TEXT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS guild_sub_live_routing');
}
