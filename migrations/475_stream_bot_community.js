/**
 * Migration 475 (Wave 2 group B, 2026-11-20): quotes, the loyalty store and media share for the stream bot
 * (docs/superpowers/specs/2026-11-19-stream-bot-design.md §15, core/stream-bot/community/).
 *
 *   stream_bot_quotes              the channel's quotes: number, text, game, who said it, who added it (platform account, so
 *                                  /privacy can find a viewer's own additions). Imported quotes (Firebot quotes.db,
 *                                  Streamer.bot quotes.dat) land switched off (enabled = 0) until the streamer turns them on.
 *   stream_bot_store_items         loyalty store items: name, cost in points, stock, a limit per viewer, a cooldown, and the
 *                                  automation to run when someone redeems one. Points are a free channel tally; nothing in
 *                                  the store is bought with money.
 *   stream_bot_store_redemptions   who redeemed what and for how many points (refunds marked), for the Store page.
 *   stream_bot_media_requests      media share: a viewer's YouTube video request, its status, and the song request it was
 *                                  handed to (its sound plays through the VOD-safe CertiFried Music source).
 *
 * All four hang off stream_bot_profiles with ON DELETE CASCADE. Redemptions and media requests are viewer data:
 * /privacy export and delete (core/stream-bot/community/privacy.js through core/stream-bot/privacy.js).
 *
 * Retention (data_retention_policy, jobs/retention-sweeper.js): redemptions 400 days, media requests 90 days (created_at).
 * Quotes and store items are the streamer's own content, kept until they delete them.
 *
 * Safe to re-run: CREATE TABLE IF NOT EXISTS, INSERT IGNORE. `communityDdl(prefix)` builds the same tables under a test prefix.
 * Run: npm run migrate -- 475_stream_bot_community.js
 */
const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const COMMUNITY_TABLES = Object.freeze(['quotes', 'store_items', 'store_redemptions', 'media_requests']);

export const RETENTION_ROWS = Object.freeze([
    ['stream_bot_store_redemptions', 'created_at', 400, 'Stream bot loyalty store redemptions (who redeemed what, for how many points): 400 days (Wave 2B)'],
    ['stream_bot_media_requests', 'created_at', 90, 'Stream bot media share requests (who asked for which video, its status): 90 days (Wave 2B)'],
]);

export function communityDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    return [
        `CREATE TABLE IF NOT EXISTS ${t('quotes')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            number INT UNSIGNED NOT NULL,
            text VARCHAR(500) NOT NULL,
            game VARCHAR(100) DEFAULT NULL,
            said_by VARCHAR(100) DEFAULT NULL,
            added_by VARCHAR(100) DEFAULT NULL,
            added_by_platform VARCHAR(8) DEFAULT NULL,
            added_by_id VARCHAR(64) DEFAULT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            imported_from VARCHAR(20) DEFAULT NULL,
            source_id VARCHAR(64) DEFAULT NULL,
            quoted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_number (profile_id, number),
            UNIQUE KEY uq_source (profile_id, imported_from, source_id),
            KEY idx_added_by (added_by_platform, added_by_id),
            CONSTRAINT ${prefix}fk_quotes_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('store_items')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            name VARCHAR(60) NOT NULL,
            description VARCHAR(200) DEFAULT NULL,
            cost BIGINT UNSIGNED NOT NULL DEFAULT 0,
            stock INT DEFAULT NULL,
            per_user_limit INT UNSIGNED DEFAULT NULL,
            limit_window VARCHAR(8) NOT NULL DEFAULT 'day',
            cooldown_sec INT UNSIGNED NOT NULL DEFAULT 0,
            automation_id BIGINT UNSIGNED DEFAULT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            sort_order INT NOT NULL DEFAULT 0,
            last_redeemed_at TIMESTAMP NULL DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_name (profile_id, name),
            CONSTRAINT ${prefix}fk_store_items_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('store_redemptions')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            item_id BIGINT UNSIGNED DEFAULT NULL,
            item_name VARCHAR(60) NOT NULL,
            platform VARCHAR(8) NOT NULL,
            platform_user_id VARCHAR(64) DEFAULT NULL,
            viewer_id BIGINT UNSIGNED DEFAULT NULL,
            viewer_name VARCHAR(100) DEFAULT NULL,
            cost BIGINT UNSIGNED NOT NULL DEFAULT 0,
            status VARCHAR(10) NOT NULL DEFAULT 'done',
            note VARCHAR(200) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_profile (profile_id, id),
            KEY idx_item_viewer (item_id, platform, platform_user_id, created_at),
            KEY idx_account (platform, platform_user_id),
            KEY idx_created (created_at),
            CONSTRAINT ${prefix}fk_store_red_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE,
            CONSTRAINT ${prefix}fk_store_red_item FOREIGN KEY (item_id) REFERENCES ${t('store_items')} (id) ON DELETE SET NULL
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('media_requests')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            platform VARCHAR(10) NOT NULL,
            viewer_id VARCHAR(64) DEFAULT NULL,
            viewer_login VARCHAR(100) DEFAULT NULL,
            viewer_name VARCHAR(100) DEFAULT NULL,
            video_id VARCHAR(16) NOT NULL,
            url VARCHAR(300) NOT NULL,
            title VARCHAR(300) DEFAULT NULL,
            channel VARCHAR(200) DEFAULT NULL,
            duration_ms INT UNSIGNED DEFAULT NULL,
            thumbnail VARCHAR(500) DEFAULT NULL,
            status VARCHAR(10) NOT NULL DEFAULT 'pending',
            music_request_id BIGINT UNSIGNED DEFAULT NULL,
            points_paid BIGINT UNSIGNED NOT NULL DEFAULT 0,
            decided_by VARCHAR(100) DEFAULT NULL,
            reason VARCHAR(200) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            decided_at TIMESTAMP NULL DEFAULT NULL,
            finished_at TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_profile_status (profile_id, status, id),
            KEY idx_music (profile_id, music_request_id),
            KEY idx_account (platform, viewer_id),
            KEY idx_created (created_at),
            CONSTRAINT ${prefix}fk_media_req_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
    ];
}

export async function up(db) {
    for (const sql of communityDdl('stream_bot_')) await db.query(sql);
    for (const [table, column, days, notes] of RETENTION_ROWS) {
        await db.query(`INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)`,
            [table, column, days, notes]);
    }
}

export async function down(db) {
    await db.query(`DELETE FROM data_retention_policy WHERE table_name IN ('stream_bot_store_redemptions', 'stream_bot_media_requests')`);
    for (const n of [...COMMUNITY_TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS \`stream_bot_${n}\``);
}

export default { up, down, communityDdl, COMMUNITY_TABLES, RETENTION_ROWS };
