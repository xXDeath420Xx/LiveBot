/**
 * Migration 470: YouTube Live for the stream bot (H-741, design §13, 2026-11-20).
 *
 *   stream_bot_youtube_live   one row per linked YouTube channel: the current broadcast and chat id, the last chat page token
 *                             (so a restart resumes the chat where it stopped), title, times, transport and the last error.
 *                             No viewer data. Cascades with stream_bot_profiles.
 *   stream_bot_youtube_quota  YouTube API units spent per Pacific day and profile (profile 0: not tied to one), so the quota
 *                             guard survives a restart. No viewer data. 30 days (data_retention_policy, updated_at).
 *
 * The YouTube sign-in itself lives in stream_platform_accounts (platform 'youtube'), the table multicast already uses; no new
 * credential table. Viewer data from YouTube goes into the existing tables under platform 'youtube'.
 *
 * Safe to run again (CREATE TABLE IF NOT EXISTS, INSERT IGNORE). Does nothing when stream_bot_profiles is missing. The live code
 * runs without these tables (memory only) until this is applied. Tests create the same tables under a throwaway prefix through
 * youtubeDdl(prefix).
 */

export const RETENTION_ROWS = Object.freeze([
    ['stream_bot_youtube_quota', 'updated_at', 30, 'Stream bot YouTube quota use per day and profile: 30 days (H-741)'],
]);

export function youtubeDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    return [
        `CREATE TABLE IF NOT EXISTS ${t('youtube_live')} (
            profile_id BIGINT UNSIGNED NOT NULL,
            channel_id VARCHAR(64) NOT NULL,
            broadcast_id VARCHAR(64) DEFAULT NULL,
            live_chat_id VARCHAR(255) DEFAULT NULL,
            page_token VARCHAR(255) DEFAULT NULL,
            title VARCHAR(200) DEFAULT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'offline',
            transport VARCHAR(8) DEFAULT NULL,
            started_at DATETIME DEFAULT NULL,
            ended_at DATETIME DEFAULT NULL,
            last_check_at DATETIME DEFAULT NULL,
            last_message_at DATETIME DEFAULT NULL,
            error VARCHAR(255) DEFAULT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (profile_id, channel_id),
            CONSTRAINT ${prefix}fk_youtube_live_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('youtube_quota')} (
            day DATE NOT NULL,
            profile_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
            units INT UNSIGNED NOT NULL DEFAULT 0,
            calls INT UNSIGNED NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (day, profile_id),
            KEY idx_updated (updated_at)
        ) ${TAIL}`,
    ];
}

async function tableExists(db, name) {
    const [rows] = await db.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]);
    return Number(rows[0].n) > 0;
}

export async function up(db) {
    if (!(await tableExists(db, 'stream_bot_profiles'))) return;
    for (const sql of youtubeDdl('stream_bot_')) await db.query(sql);
    if (await tableExists(db, 'data_retention_policy')) {
        for (const [table, column, days, notes] of RETENTION_ROWS) {
            await db.query('INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)',
                [table, column, days, notes]);
        }
    }
}

export async function down(db) {
    if (await tableExists(db, 'data_retention_policy')) {
        await db.query("DELETE FROM data_retention_policy WHERE table_name IN ('stream_bot_youtube_quota')");
    }
    await db.query('DROP TABLE IF EXISTS `stream_bot_youtube_quota`');
    await db.query('DROP TABLE IF EXISTS `stream_bot_youtube_live`');
}

export default { up, down, youtubeDdl, RETENTION_ROWS };
