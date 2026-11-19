/*
 * Migration 265: columns three community features were already writing to, but never had.
 *
 * tags (/engage tags, `!name` triggers, dashboard Tags page)
 *   use_count   INT NOT NULL DEFAULT 0  — bumped on every use; /engage tags list|search|top|info and the
 *                                         dashboard's "most used" read it.
 *   embed_data  TEXT NULL               — JSON for the optional embed (/engage tags create|edit
 *                                         embed-title / embed-description / embed-color).
 *   updated_at  TIMESTAMP NULL          — set on /engage tags edit; shown as "Last Updated" (readers
 *                                         fall back to created_at while it is NULL). No ON UPDATE:
 *                                         a use_count bump is not an edit.
 *   Every INSERT/UPDATE named these (and `content` instead of tag_content), so no tag could ever be
 *   created — the table is empty.
 *
 * starboard_messages (core/starboard-manager.js)
 *   original_channel_id VARCHAR(20) NULL  — jump link in /community starboard top.
 *   star_count          INT NOT NULL DEFAULT 0 — /community starboard stats + top.
 *   The INSERT that records a starboard post named both columns, so it always failed AFTER the post
 *   had been sent. With no row, the next star found "not on the board yet" and posted it again —
 *   the duplicate starboard posts seen in all 7 starboard guilds. The table is empty for the same
 *   reason; the duplicates already in those channels have to be removed by hand.
 *
 * reaction_role_mappings (/manage roles add-role)
 *   description VARCHAR(100) NULL — the command's "description for select menu options". NULL keeps
 *                                   the renderer's existing "Get the <role> role" text, so the 663
 *                                   dashboard-made mappings render exactly as before. 100 = Discord's
 *                                   limit for a select option description.
 *
 * Idempotent: each column is added only if information_schema doesn't already list it.
 */

const COLUMNS = [
    ['tags', 'use_count', 'INT NOT NULL DEFAULT 0 AFTER creator_id'],
    ['tags', 'embed_data', 'TEXT NULL AFTER tag_content'],
    ['tags', 'updated_at', 'TIMESTAMP NULL DEFAULT NULL AFTER created_at'],
    ['starboard_messages', 'original_channel_id', 'VARCHAR(20) NULL AFTER original_message_id'],
    ['starboard_messages', 'star_count', 'INT NOT NULL DEFAULT 0 AFTER starboard_message_id'],
    ['reaction_role_mappings', 'description', 'VARCHAR(100) NULL AFTER label'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, definition] of COLUMNS) {
        if (await hasColumn(db, table, column)) continue;
        await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
        console.log(`[265] ${table}.${column} added`);
    }
}

export async function down(db) {
    // Reverses only what up() added.
    for (const [table, column] of [...COLUMNS].reverse()) {
        if (!(await hasColumn(db, table, column))) continue;
        await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    }
}
