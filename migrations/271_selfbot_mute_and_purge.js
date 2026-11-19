/*
 * Migration 271: selfbot_detection_config.mute_duration_minutes + purge_messages.
 *
 * `/protection selfbot config` offers `mute_duration` and `purge_messages` and writes them to these
 * columns, and core/selfbot-detection-manager.js reads them — but the table never had them:
 *   - the config command failed with "Unknown column" whenever either option was given;
 *   - the 'mute' action (9 guilds) computed timeout(undefined * 60000) = NaN, which throws, so the
 *     member was never muted AND the alert (sent after the action) was never posted.
 *
 * Types and defaults match raid_detection_config's twin columns. purge_messages defaults to 0 so
 * existing guilds keep exactly today's behaviour (no purge) until someone turns it on.
 * The manager also falls back to 60 minutes when the value is NULL, so code and migration can
 * deploy in either order.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasColumn(db, column) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'selfbot_detection_config' AND COLUMN_NAME = ?`,
        [column]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'mute_duration_minutes'))) {
        await db.execute(
            'ALTER TABLE selfbot_detection_config ADD COLUMN mute_duration_minutes INT NULL DEFAULT 60 AFTER alert_channel_id'
        );
    }
    if (!(await hasColumn(db, 'purge_messages'))) {
        await db.execute(
            'ALTER TABLE selfbot_detection_config ADD COLUMN purge_messages TINYINT(1) NULL DEFAULT 0 AFTER mute_duration_minutes'
        );
    }
}

export async function down(db) {
    if (await hasColumn(db, 'purge_messages')) {
        await db.execute('ALTER TABLE selfbot_detection_config DROP COLUMN purge_messages');
    }
    if (await hasColumn(db, 'mute_duration_minutes')) {
        await db.execute('ALTER TABLE selfbot_detection_config DROP COLUMN mute_duration_minutes');
    }
}
