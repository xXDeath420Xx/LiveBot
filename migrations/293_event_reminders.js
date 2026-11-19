/*
 * Migration 293: Discord scheduled-event reminders, start announcements and recurring templates.
 *
 * The three tables below were created long ago and never written. They are reused rather than
 * replaced:
 *
 *   scheduled_events_config  becomes the persisted mirror of each guild's Discord scheduled events
 *                            (one row per event, upserted from the gateway events and by the
 *                            recurring job). The reminder job reads due work from here, which is
 *                            what makes reminders survive a restart. Added:
 *                              status              scheduled | active | completed | canceled | deleted
 *                              reminder_sent_at    set once every interested member has been DM'd
 *                              start_announced_at  claim for the "starting now" channel post
 *                              recurring_event_id  the recurring_events template that created it
 *   event_subscriptions      who clicked "Interested" (GuildScheduledEventUserAdd/Remove), with the
 *                            existing per-user reminder_sent flag. Added guild_id so opt-outs can
 *                            be applied without a join through the mirror.
 *   recurring_events         templates that create the next Discord event after one ends. Added
 *                            failure_count / last_error so a template whose channel was deleted
 *                            (or that lost Manage Events) pauses itself after repeated failures
 *                            instead of retrying every minute forever.
 *
 * New: event_reminder_optouts — members who pressed "Stop reminders from this server" (or ran
 * /schedule discord reminders enabled:false). Keyed per guild.
 *
 * Per-guild settings (DM reminders on/off, minutes before, announcement channel/role) live in
 * guild_feature_config under feature key 'event-reminders' (core/feature-config-spec.js). All of
 * it defaults OFF.
 *
 * Apply directly: import { up } and call up(pool).
 */
const COLUMNS = [
    ['scheduled_events_config', 'status', "VARCHAR(16) NOT NULL DEFAULT 'scheduled'"],
    ['scheduled_events_config', 'reminder_sent_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['scheduled_events_config', 'start_announced_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['scheduled_events_config', 'recurring_event_id', 'INT NULL DEFAULT NULL'],
    ['event_subscriptions', 'guild_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['recurring_events', 'failure_count', 'INT NOT NULL DEFAULT 0'],
    ['recurring_events', 'last_error', 'VARCHAR(255) NULL DEFAULT NULL'],
];

const INDEXES = [
    ['scheduled_events_config', 'idx_status_start', '(`status`, `scheduled_start`)'],
    ['scheduled_events_config', 'idx_recurring', '(`recurring_event_id`)'],
    ['event_subscriptions', 'idx_event_pending', '(`event_id`, `reminder_sent`)'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }
    for (const [table, index, cols] of INDEXES) {
        if (!(await hasIndex(db, table, index))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` ${cols}`);
        }
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS event_reminder_optouts (
            guild_id    VARCHAR(20) NOT NULL,
            user_id     VARCHAR(20) NOT NULL,
            created_at  TIMESTAMP   NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS event_reminder_optouts');
    for (const [table, index] of INDEXES) {
        if (await hasIndex(db, table, index)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
        }
    }
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
