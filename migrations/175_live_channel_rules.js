/**
 * Role-based live channel routing rules.
 *
 * Generalises migration 174's single subscriber channel into an ordered list: each rule
 * maps a set of roles to a live channel, and the highest-priority matching rule wins.
 * That gives the usual ladder — subscribers beat team members, team members beat
 * everyone else — without hard-coding any of those tiers.
 *
 * role_ids NULL          = auto-detect the Twitch-integration subscriber roles.
 * source_channel_ids NULL = the rule may reroute out of any channel.
 * apply_to_unrouted 1     = the rule also acts as the DEFAULT channel for a matching
 *                           member whose subscription resolves to no channel at all.
 *                           Off by default so adding a rule can't silently wake up
 *                           subscriptions that were previously going nowhere.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS guild_live_channel_rules (
            rule_id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            label VARCHAR(64) DEFAULT NULL,
            role_ids TEXT DEFAULT NULL,
            channel_id VARCHAR(20) NOT NULL,
            priority INT NOT NULL DEFAULT 0,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            exclude_owner TINYINT(1) NOT NULL DEFAULT 1,
            excluded_user_ids TEXT DEFAULT NULL,
            source_channel_ids TEXT DEFAULT NULL,
            apply_to_unrouted TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_guild_priority (guild_id, priority)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Carry migration 174's rows over as the top-priority "Subscribers" rule.
    try {
        const [existing] = await db.execute('SELECT COUNT(*) AS n FROM guild_live_channel_rules');
        if (!existing[0] || existing[0].n === 0) {
            await db.execute(`
                INSERT INTO guild_live_channel_rules
                    (guild_id, label, role_ids, channel_id, priority, enabled, exclude_owner, excluded_user_ids, source_channel_ids)
                SELECT guild_id, 'Subscribers', subscriber_role_ids, channel_id, 100, enabled, exclude_owner, excluded_user_ids, source_channel_ids
                FROM guild_sub_live_routing
            `);
        }
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    }

    await db.execute('DROP TABLE IF EXISTS guild_sub_live_routing');
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS guild_live_channel_rules');
}
