import pool from '../utils/db.js';

/**
 * Default-deny link filtering: per-guild config, the allow/deny domain lists moderators build by
 * ruling on the queue, and a record of every verdict.
 *
 * Opt-in per guild and off by default. A guild with no self-promo rules should only ever see the
 * commission filter, so this stays dormant until someone turns it on for a specific server.
 *
 * The decisions table is the queue AND the log — a 'review' verdict leaves the message up and
 * lands here as 'pending'; a 'block' verdict deletes and lands here as 'removed' with the content
 * preserved, so a wrong call can be checked and undone. Approving a domain writes it to
 * link_policy_domains, which is how the allowlist builds itself out of real traffic instead of
 * having to be guessed up front.
 */
export async function up() {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS link_policy_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 0,
            -- what to do with a domain nobody recognises
            unknown_action ENUM('review','block') NOT NULL DEFAULT 'review',
            -- Ko-fi / Patreon / Throne — legitimate in some servers, self-promo in others
            monetisation_action ENUM('allow','review','block') NOT NULL DEFAULT 'review',
            -- shorteners and commission marketplaces; 'review' softens the filter for a cautious guild
            blocked_action ENUM('delete','review') NOT NULL DEFAULT 'delete',
            dm_user TINYINT(1) NOT NULL DEFAULT 1,
            -- both optional: with neither set the queue lives in the dashboard only, which is the
            -- normal case. This feature never creates channels.
            review_channel_id VARCHAR(20) NULL,
            log_channel_id VARCHAR(20) NULL,
            exempt_channel_ids MEDIUMTEXT NULL,
            deleted_count INT NOT NULL DEFAULT 0,
            review_count INT NOT NULL DEFAULT 0,
            last_hit_at TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS link_policy_domains (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            domain VARCHAR(255) NOT NULL,
            kind ENUM('allow','deny') NOT NULL DEFAULT 'allow',
            note VARCHAR(255) NULL,
            created_by VARCHAR(20) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_domain (guild_id, domain),
            INDEX idx_guild_kind (guild_id, kind)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS link_policy_decisions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            message_id VARCHAR(20) NULL,
            content MEDIUMTEXT NULL,
            attachments MEDIUMTEXT NULL,
            host VARCHAR(255) NULL,
            domain VARCHAR(255) NULL,
            category VARCHAR(32) NULL,
            all_links MEDIUMTEXT NULL,
            verdict ENUM('review','block') NOT NULL,
            deleted TINYINT(1) NOT NULL DEFAULT 0,
            decision ENUM('pending','approved','removed','false_positive') NOT NULL DEFAULT 'pending',
            decided_by VARCHAR(20) NULL,
            decided_at DATETIME NULL,
            review_message_id VARCHAR(20) NULL,
            log_message_id VARCHAR(20) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_guild_decision (guild_id, decision),
            INDEX idx_guild_domain (guild_id, domain)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('[Migration 193] link policy tables ready (feature off by default)');
}

export async function down() {
    await pool.execute('DROP TABLE IF EXISTS link_policy_decisions');
    await pool.execute('DROP TABLE IF EXISTS link_policy_domains');
    await pool.execute('DROP TABLE IF EXISTS link_policy_config');
    console.log('[Migration 193] link policy tables dropped');
}
