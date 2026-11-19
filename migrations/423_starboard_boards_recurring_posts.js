/**
 * Migration 423 — several starboards per server, and recurring channel messages.
 *
 * starboard_config (core/starboard-manager.js, partials/manage/starboard.ejs)
 *   Was one row per guild (PRIMARY KEY guild_id). Now one row per board:
 *     id                      INT AUTO_INCREMENT PRIMARY KEY (existing rows get an id each, nothing else changes)
 *     KEY idx_starboard_config_guild (guild_id)
 *     name                    VARCHAR(100) NULL      shown on the dashboard and in the server log
 *     watch_channels          TEXT NULL              JSON array: only messages in these channels/categories count
 *     channel_thresholds      TEXT NULL              JSON object { channelId: threshold }
 *     ignore_bots             TINYINT(1) DEFAULT 0   messages by bots and webhooks are not starred
 *     min_age_minutes         INT DEFAULT 0          a younger message is not posted yet
 *     max_age_minutes         INT DEFAULT 0          an older message is not posted (0 = no limit)
 *     remove_below_threshold  TINYINT(1) DEFAULT 1   take the post down when the count drops (what it always did)
 *     remove_on_delete        TINYINT(1) DEFAULT 1   take the post down when the original is deleted (what it always did)
 *   The existing 7 rows keep their channel, threshold, emoji list, self-star and ignored channels;
 *   the new columns default to the behaviour they had before.
 *
 * starboard_messages
 *     board_id                INT NULL               which board made the post; backfilled from the
 *                                                    guild's (single) board
 *     UNIQUE (board_id, original_message_id)         replaces UNIQUE (original_message_id): the same
 *                                                    message may now be on more than one board
 *
 * scheduled_announcements (core/scheduled-announcements-manager.js, partials/manage/scheduled-messages.ejs)
 *     name                    VARCHAR(100) NULL      label on the dashboard
 *     ping_role_id            VARCHAR(20) NULL       role to mention ('everyone' for @everyone)
 *     end_at                  TIMESTAMP NULL         stop after this time
 *     max_runs                INT NULL               stop after this many posts
 *     last_error              VARCHAR(255) NULL      why the last post failed (cleared on success)
 *
 * Idempotent: every step checks information_schema first.
 */

async function hasColumn(db, table, column) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]);
    return rows.length > 0;
}

const STARBOARD_COLUMNS = [
    ['name', 'VARCHAR(100) NULL DEFAULT NULL AFTER guild_id'],
    ['watch_channels', 'TEXT NULL DEFAULT NULL AFTER ignore_channels'],
    ['channel_thresholds', 'TEXT NULL DEFAULT NULL AFTER watch_channels'],
    ['ignore_bots', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER self_star'],
    ['min_age_minutes', 'INT NOT NULL DEFAULT 0 AFTER ignore_bots'],
    ['max_age_minutes', 'INT NOT NULL DEFAULT 0 AFTER min_age_minutes'],
    ['remove_below_threshold', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER max_age_minutes'],
    ['remove_on_delete', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER remove_below_threshold'],
];

const ANNOUNCEMENT_COLUMNS = [
    ['name', 'VARCHAR(100) NULL DEFAULT NULL AFTER channel_id'],
    ['ping_role_id', 'VARCHAR(20) NULL DEFAULT NULL AFTER embed_data'],
    ['end_at', 'TIMESTAMP NULL DEFAULT NULL AFTER next_run'],
    ['max_runs', 'INT NULL DEFAULT NULL AFTER end_at'],
    ['last_error', 'VARCHAR(255) NULL DEFAULT NULL AFTER run_count'],
];

export async function up(db) {
    // starboard_config: guild_id PK -> id PK
    if (!(await hasColumn(db, 'starboard_config', 'id'))) {
        await db.query(`ALTER TABLE starboard_config
            DROP PRIMARY KEY,
            ADD COLUMN id INT NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`);
        console.log('[423] starboard_config.id added as the primary key');
    }
    if (!(await hasIndex(db, 'starboard_config', 'idx_starboard_config_guild'))) {
        await db.query('ALTER TABLE starboard_config ADD KEY idx_starboard_config_guild (guild_id)');
    }
    for (const [column, definition] of STARBOARD_COLUMNS) {
        if (await hasColumn(db, 'starboard_config', column)) continue;
        await db.query(`ALTER TABLE starboard_config ADD COLUMN \`${column}\` ${definition}`);
        console.log(`[423] starboard_config.${column} added`);
    }

    // starboard_messages: which board a post belongs to
    if (!(await hasColumn(db, 'starboard_messages', 'board_id'))) {
        await db.query('ALTER TABLE starboard_messages ADD COLUMN board_id INT NULL DEFAULT NULL AFTER guild_id');
        console.log('[423] starboard_messages.board_id added');
    }
    // Every guild had exactly one board until now, so its posts belong to that board.
    await db.query(`UPDATE starboard_messages m
        JOIN (SELECT guild_id, MIN(id) AS id FROM starboard_config GROUP BY guild_id) c ON c.guild_id = m.guild_id
        SET m.board_id = c.id WHERE m.board_id IS NULL`);
    if (await hasIndex(db, 'starboard_messages', 'original_message_id')) {
        await db.query('ALTER TABLE starboard_messages DROP INDEX original_message_id');
    }
    if (!(await hasIndex(db, 'starboard_messages', 'uniq_starboard_board_msg'))) {
        await db.query('ALTER TABLE starboard_messages ADD UNIQUE KEY uniq_starboard_board_msg (board_id, original_message_id)');
    }

    // scheduled_announcements: dashboard fields
    for (const [column, definition] of ANNOUNCEMENT_COLUMNS) {
        if (await hasColumn(db, 'scheduled_announcements', column)) continue;
        await db.query(`ALTER TABLE scheduled_announcements ADD COLUMN \`${column}\` ${definition}`);
        console.log(`[423] scheduled_announcements.${column} added`);
    }
}

export async function down(db) {
    for (const [column] of [...ANNOUNCEMENT_COLUMNS].reverse()) {
        if (await hasColumn(db, 'scheduled_announcements', column)) {
            await db.query(`ALTER TABLE scheduled_announcements DROP COLUMN \`${column}\``);
        }
    }
    if (await hasIndex(db, 'starboard_messages', 'uniq_starboard_board_msg')) {
        await db.query('ALTER TABLE starboard_messages DROP INDEX uniq_starboard_board_msg');
    }
    if (await hasColumn(db, 'starboard_messages', 'board_id')) {
        await db.query('ALTER TABLE starboard_messages DROP COLUMN board_id');
    }
    if (!(await hasIndex(db, 'starboard_messages', 'original_message_id'))) {
        await db.query('ALTER TABLE starboard_messages ADD UNIQUE KEY original_message_id (original_message_id)');
    }
    for (const [column] of [...STARBOARD_COLUMNS].reverse()) {
        if (await hasColumn(db, 'starboard_config', column)) {
            await db.query(`ALTER TABLE starboard_config DROP COLUMN \`${column}\``);
        }
    }
    if (await hasColumn(db, 'starboard_config', 'id')) {
        // Going back to one board per guild keeps each guild's oldest board.
        await db.query(`DELETE c FROM starboard_config c
            JOIN starboard_config o ON o.guild_id = c.guild_id AND o.id < c.id`);
        await db.query('ALTER TABLE starboard_config DROP PRIMARY KEY, DROP COLUMN id, ADD PRIMARY KEY (guild_id)');
    }
    if (await hasIndex(db, 'starboard_config', 'idx_starboard_config_guild')) {
        await db.query('ALTER TABLE starboard_config DROP INDEX idx_starboard_config_guild');
    }
}
