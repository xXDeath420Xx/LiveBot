/**
 * Migration 464 (H-747, 2026-11-19): viewer stats and loyalty points for the stream bot
 * (docs/superpowers/specs/2026-11-19-stream-bot-design.md §11, core/stream-bot/viewers/).
 *
 *   stream_bot_viewers          one row per viewer per profile and platform (Twitch, Kick): platform user id, login and
 *                               display name (kept current), first and last seen, watch minutes, chat messages, points,
 *                               and follow / sub / gift / Bits / raid / tip counts and amounts as tracked (CertiFried never
 *                               handles money). person_id links one person's Twitch and Kick rows, only when the streamer
 *                               links them by hand (the primary row holds the points). imported_* hold what an import
 *                               added, so a second import replaces its own share instead of adding it again.
 *   stream_bot_viewer_history   point changes that are not the regular watch-time earnings (bonuses, commands, edits on the
 *                               dashboard, imports), rank-ups and links, for the viewer's page on the dashboard.
 *
 * Both hang off stream_bot_profiles with ON DELETE CASCADE (the history also off its viewer). Viewer rows are viewer
 * data: /privacy export and delete (core/stream-bot/viewers/privacy.js through core/stream-bot/privacy.js), the viewer
 * self-serve page /privacy/viewer, and the streamer's profile delete.
 *
 * Retention (data_retention_policy, jobs/retention-sweeper.js): a viewer not seen for 400 days is deleted (last_seen_at),
 * with their history (FK cascade); history rows are kept 400 days (created_at).
 *
 * Safe to re-run: CREATE TABLE IF NOT EXISTS, INSERT IGNORE. `viewersDdl(prefix)` builds the same tables under a test prefix.
 * Run: npm run migrate -- 464_stream_bot_viewers.js
 */
const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const VIEWER_TABLES = Object.freeze(['viewers', 'viewer_history']);

export const RETENTION_ROWS = Object.freeze([
    ['stream_bot_viewers', 'last_seen_at', 400, 'Stream bot viewer records (watch time, messages, points): deleted 400 days after the viewer was last seen (H-747)'],
    ['stream_bot_viewer_history', 'created_at', 400, 'Stream bot viewer point history: 400 days (H-747)'],
]);

export function viewersDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    const U = 'INT UNSIGNED NOT NULL DEFAULT 0';
    return [
        `CREATE TABLE IF NOT EXISTS ${t('viewers')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            platform VARCHAR(8) NOT NULL,
            platform_user_id VARCHAR(64) NOT NULL,
            login VARCHAR(100) DEFAULT NULL,
            display_name VARCHAR(100) DEFAULT NULL,
            roles VARCHAR(80) DEFAULT NULL,
            person_id BIGINT UNSIGNED DEFAULT NULL,
            first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            watch_minutes ${U},
            messages ${U},
            points BIGINT NOT NULL DEFAULT 0,
            follows ${U},
            followed_at TIMESTAMP NULL DEFAULT NULL,
            subs ${U},
            sub_months ${U},
            gifts ${U},
            gifted_subs ${U},
            cheers ${U},
            bits BIGINT UNSIGNED NOT NULL DEFAULT 0,
            raids ${U},
            raid_viewers ${U},
            tips ${U},
            tip_amounts VARCHAR(400) DEFAULT NULL,
            rank_name VARCHAR(60) DEFAULT NULL,
            imported_from VARCHAR(40) DEFAULT NULL,
            imported_minutes ${U},
            imported_messages ${U},
            imported_points BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_viewer (profile_id, platform, platform_user_id),
            KEY idx_points (profile_id, points),
            KEY idx_watch (profile_id, watch_minutes),
            KEY idx_messages (profile_id, messages),
            KEY idx_profile_seen (profile_id, last_seen_at),
            KEY idx_login (profile_id, login),
            KEY idx_account (platform, platform_user_id),
            KEY idx_last_seen (last_seen_at),
            KEY idx_person (person_id),
            CONSTRAINT ${prefix}fk_viewers_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE,
            CONSTRAINT ${prefix}fk_viewers_person FOREIGN KEY (person_id) REFERENCES ${t('viewers')} (id) ON DELETE SET NULL
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('viewer_history')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            viewer_id BIGINT UNSIGNED NOT NULL,
            kind VARCHAR(16) NOT NULL,
            delta BIGINT DEFAULT NULL,
            balance BIGINT DEFAULT NULL,
            note VARCHAR(200) DEFAULT NULL,
            actor VARCHAR(100) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_viewer (viewer_id, id),
            KEY idx_profile (profile_id, id),
            KEY idx_created (created_at),
            CONSTRAINT ${prefix}fk_vhist_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE,
            CONSTRAINT ${prefix}fk_vhist_viewer FOREIGN KEY (viewer_id) REFERENCES ${t('viewers')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
    ];
}

export async function up(db) {
    for (const sql of viewersDdl('stream_bot_')) await db.query(sql);
    for (const [table, column, days, notes] of RETENTION_ROWS) {
        await db.query(`INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)`,
            [table, column, days, notes]);
    }
}

export async function down(db) {
    await db.query(`DELETE FROM data_retention_policy WHERE table_name IN ('stream_bot_viewers', 'stream_bot_viewer_history')`);
    await db.query('DROP TABLE IF EXISTS `stream_bot_viewer_history`');
    await db.query('DROP TABLE IF EXISTS `stream_bot_viewers`');
}

export default { up, down, viewersDdl, VIEWER_TABLES, RETENTION_ROWS };
