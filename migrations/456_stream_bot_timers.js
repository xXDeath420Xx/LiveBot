/**
 * Migration 456 — stream bot timers on the existing timed-message table (docs/superpowers/specs/2026-11-19-stream-bot-design.md §7.4).
 *
 * The Kick timer job (jobs/kick-timer-scheduler.js) and its table `tokes_timers` (migration 128) are extended rather
 * than copied. New columns, all with defaults that keep today's behaviour for existing rows:
 *
 *   profile_id      stream bot profile that owns the timer (NULL: a Kick channel page timer, owned through channel_id)
 *   name            label on the stream bot Timers page
 *   platforms       where a stream bot timer posts: twitch | kick | all (Kick channel page timers: their channel)
 *   extra_messages  JSON array of more messages after `message`; with rotation they take turns
 *   rotation        rotate | random
 *   next_index      the next message for rotate
 *   only_live       1: post only while the channel is live
 *   min_chat_lines  post only after this many chat lines since the timer's last post in that channel (0: no minimum)
 *   automation_id   run this stream bot automation instead of posting a message
 *
 * channel_id becomes NULL-able (stream bot timers have no Kick channel page row). Stream bot timers are kept until
 * deleted, and go with the profile (FK ON DELETE CASCADE; /privacy delete removes the profile); /privacy export lists
 * them (core/stream-bot/privacy.js). No retention row: like automations they are settings, not activity.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS, and each foreign key is added only when information_schema lacks it.
 * `timersTestDdl(table)` builds a throwaway copy for tests.
 */

const COLUMNS = [
    "ADD COLUMN IF NOT EXISTS profile_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER channel_id",
    "ADD COLUMN IF NOT EXISTS name VARCHAR(100) NULL DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS platforms VARCHAR(10) NULL DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS extra_messages LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL CHECK (extra_messages IS NULL OR json_valid(extra_messages))",
    "ADD COLUMN IF NOT EXISTS rotation VARCHAR(8) NOT NULL DEFAULT 'rotate'",
    "ADD COLUMN IF NOT EXISTS next_index INT NOT NULL DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS only_live TINYINT(1) NOT NULL DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS min_chat_lines INT NOT NULL DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS automation_id BIGINT UNSIGNED NULL DEFAULT NULL",
];

/** A throwaway table with the same shape (tests). */
export function timersTestDdl(table) {
    return `CREATE TABLE IF NOT EXISTS \`${table}\` (
        id INT PRIMARY KEY AUTO_INCREMENT,
        channel_id INT NULL,
        profile_id BIGINT UNSIGNED NULL,
        message VARCHAR(500) NOT NULL,
        interval_min INT NOT NULL DEFAULT 30,
        is_enabled TINYINT(1) NOT NULL DEFAULT 1,
        last_sent_at TIMESTAMP NULL,
        send_count INT NOT NULL DEFAULT 0,
        created_by VARCHAR(64) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        name VARCHAR(100) NULL,
        platforms VARCHAR(10) NULL,
        extra_messages LONGTEXT NULL,
        rotation VARCHAR(8) NOT NULL DEFAULT 'rotate',
        next_index INT NOT NULL DEFAULT 0,
        only_live TINYINT(1) NOT NULL DEFAULT 0,
        min_chat_lines INT NOT NULL DEFAULT 0,
        automation_id BIGINT UNSIGNED NULL,
        KEY idx_profile (profile_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

async function hasConstraint(db, table, name) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, [table, name]);
    return rows.length > 0;
}

export async function up(db) {
    await db.query('ALTER TABLE tokes_timers MODIFY channel_id INT NULL');
    await db.query(`ALTER TABLE tokes_timers ${COLUMNS.join(', ')}`);
    await db.query('ALTER TABLE tokes_timers ADD KEY IF NOT EXISTS idx_profile (profile_id)');
    if (!(await hasConstraint(db, 'tokes_timers', 'fk_tokes_timers_sb_profile'))) {
        await db.query(`ALTER TABLE tokes_timers ADD CONSTRAINT fk_tokes_timers_sb_profile FOREIGN KEY (profile_id)
                        REFERENCES stream_bot_profiles (id) ON DELETE CASCADE`);
    }
    if (!(await hasConstraint(db, 'tokes_timers', 'fk_tokes_timers_sb_automation'))) {
        await db.query(`ALTER TABLE tokes_timers ADD CONSTRAINT fk_tokes_timers_sb_automation FOREIGN KEY (automation_id)
                        REFERENCES stream_bot_automations (id) ON DELETE SET NULL`);
    }
}

export async function down(db) {
    for (const fk of ['fk_tokes_timers_sb_profile', 'fk_tokes_timers_sb_automation']) {
        if (await hasConstraint(db, 'tokes_timers', fk)) await db.query(`ALTER TABLE tokes_timers DROP FOREIGN KEY ${fk}`);
    }
    await db.query('DELETE FROM tokes_timers WHERE channel_id IS NULL');
    await db.query(`ALTER TABLE tokes_timers DROP KEY IF EXISTS idx_profile, DROP COLUMN IF EXISTS profile_id, DROP COLUMN IF EXISTS name,
                    DROP COLUMN IF EXISTS platforms, DROP COLUMN IF EXISTS extra_messages, DROP COLUMN IF EXISTS rotation, DROP COLUMN IF EXISTS next_index,
                    DROP COLUMN IF EXISTS only_live, DROP COLUMN IF EXISTS min_chat_lines, DROP COLUMN IF EXISTS automation_id`);
    await db.query('ALTER TABLE tokes_timers MODIFY channel_id INT NOT NULL');
}
