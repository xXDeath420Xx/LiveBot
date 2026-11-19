/**
 * Migration 448 — suggestions wait for staff when approval is required (register H-662).
 *
 * A held suggestion gets a review card (Approve / Reject buttons) in the staff review channel.
 * review_channel_id / review_message_id point at that card so core/suggestion-review.js can close it
 * whichever way the decision is made: the card's buttons, /engage suggest approve|reject, or the
 * dashboard.
 *
 * Idempotent: each column is added only when missing.
 */
const COLUMNS = [
    ['review_channel_id', 'VARCHAR(20) NULL DEFAULT NULL AFTER channel_id'],
    ['review_message_id', 'VARCHAR(20) NULL DEFAULT NULL AFTER review_channel_id'],
];

async function has(db, column) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suggestions' AND COLUMN_NAME = ? LIMIT 1`, [column]);
    return rows.length > 0;
}

export async function up(db) {
    for (const [column, definition] of COLUMNS) {
        if (!(await has(db, column))) await db.query(`ALTER TABLE suggestions ADD COLUMN ${column} ${definition}`);
    }
}

export async function down(db) {
    for (const [column] of [...COLUMNS].reverse()) {
        if (await has(db, column)) await db.query(`ALTER TABLE suggestions DROP COLUMN ${column}`);
    }
}
