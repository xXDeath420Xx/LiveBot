/*
 * Migration 266: what /fun quotes shows about a quote that quotes_enhanced had nowhere to keep.
 *
 * The table has the quote text (quote_text), the quoted member (user_id), who saved it (added_by)
 * and when (created_at) — commands/fun/fun-quotes-handler.js now uses those. It also shows:
 *
 *   channel_id   VARCHAR(20) NULL   — with message_id, the "jump to message" link on every quote embed
 *   message_id   VARCHAR(20) NULL
 *   author_name  VARCHAR(100) NULL  — the quoted member's name as it was when saved: the embed author
 *                                     line, the list/search rows, and what search matches on. Kept
 *                                     because the member may have left or renamed since.
 *   quote_name   VARCHAR(100) NULL  — the optional "name/tag for this quote" (/fun quotes save name:),
 *                                     shown as the embed title and searchable.
 *
 * The save INSERT named all of these plus non-existent content/author_id/saved_by/saved_at, so no
 * quote was ever saved — the table is empty and nothing needs backfilling.
 *
 * Idempotent: each column is added only if information_schema doesn't already list it.
 */

const COLUMNS = [
    ['channel_id', 'VARCHAR(20) NULL AFTER guild_id'],
    ['message_id', 'VARCHAR(20) NULL AFTER channel_id'],
    ['author_name', 'VARCHAR(100) NULL AFTER user_id'],
    ['quote_name', 'VARCHAR(100) NULL AFTER quote_text'],
];

async function hasColumn(db, column) {
    const [rows] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotes_enhanced' AND COLUMN_NAME = ?`,
        [column]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [column, definition] of COLUMNS) {
        if (await hasColumn(db, column)) continue;
        await db.execute(`ALTER TABLE quotes_enhanced ADD COLUMN \`${column}\` ${definition}`);
        console.log(`[266] quotes_enhanced.${column} added`);
    }
}

export async function down(db) {
    // Reverses only what up() added.
    for (const [column] of [...COLUMNS].reverse()) {
        if (!(await hasColumn(db, column))) continue;
        await db.execute(`ALTER TABLE quotes_enhanced DROP COLUMN \`${column}\``);
    }
}
