/*
 * Migration 278: columns the dashboard's settings forms already offer but had nowhere to save.
 *
 *   music_config.max_playlists_per_user, max_songs_per_playlist
 *       The Music page's "Playlist limits" form posts these; the route tried to insert a playlist row
 *       instead and always failed. handlers/music/playlist.js enforces them (NULL = no limit).
 *   economy_config.max_bank_capacity
 *       The Economy page's "Max bank capacity" field. New accounts get this capacity; NULL keeps the
 *       existing rule (10x the starting balance) in core/economy-manager.js.
 *   auto_meme_config.subreddit widened to VARCHAR(500)
 *       The Auto-memes page saves a comma-separated list of subreddits; core/auto-meme-manager.js
 *       picks one per post. 50 characters only fit two or three names.
 *   guild_command_restrictions.denied_channels
 *       The Permissions page can deny a command in a channel. core/command-restrictions.js already
 *       enforces allowed/denied roles and allowed channels; this adds the denied-channel list
 *       (JSON array of channel ids), checked alongside them.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['music_config', 'max_playlists_per_user', 'INT NULL DEFAULT NULL'],
    ['music_config', 'max_songs_per_playlist', 'INT NULL DEFAULT NULL'],
    ['economy_config', 'max_bank_capacity', 'BIGINT NULL DEFAULT NULL'],
    ['guild_command_restrictions', 'denied_channels', 'LONGTEXT NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }
    // Widen only (never narrows): skip if it is already at least 500 characters.
    const [[col]] = await db.execute(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_meme_config' AND COLUMN_NAME = 'subreddit'`);
    if (col && Number(col.len) < 500) {
        await db.execute("ALTER TABLE auto_meme_config MODIFY subreddit VARCHAR(500) NULL DEFAULT 'memes'");
    }
}

export async function down(db) {
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
