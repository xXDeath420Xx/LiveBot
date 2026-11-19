/*
 * 333 — where a member was last active, not only when (owner, 2026-10-13: the Verification log should link
 * to the post or voice channel that cancelled an inactivity warning).
 *
 *   member_activity   + last_message_channel_id, last_message_id, last_voice_channel_id. Written by the same
 *                       batched flush as the times (core/member-activity.js); NULL for activity recorded before
 *                       this migration (the log then shows the time only).
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export const COLUMNS = [
    ['last_message_channel_id', 'VARCHAR(20) DEFAULT NULL AFTER last_message_at'],
    ['last_message_id', 'VARCHAR(20) DEFAULT NULL AFTER last_message_channel_id'],
    ['last_voice_channel_id', 'VARCHAR(20) DEFAULT NULL AFTER last_voice_at'],
];

export async function up(db) {
    for (const [name, def] of COLUMNS) {
        if (!(await hasColumn(db, 'member_activity', name))) await db.execute(`ALTER TABLE member_activity ADD COLUMN ${name} ${def}`);
    }
}

export async function down(db) {
    for (const [name] of COLUMNS.slice().reverse()) {
        if (await hasColumn(db, 'member_activity', name)) await db.execute(`ALTER TABLE member_activity DROP COLUMN ${name}`);
    }
}

export default { up, down, COLUMNS };
