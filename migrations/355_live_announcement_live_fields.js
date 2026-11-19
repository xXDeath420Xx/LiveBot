/**
 * Migration 355 — expose "live" fields on live_announcements for in-place edits.
 *
 * Adds last_viewer_count + last_edited_at so the per-5-minute editor job
 * (jobs/stream-live-editor.js) can show "stream has been live for X · peak Y
 * viewers" without constantly re-fetching from Twitch. Live stream posts stay
 * current in the channel as the stream progresses (P2.4 — Sapphire parity).
 *
 * Idempotent.
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'live_announcements', 'last_viewer_count'))) {
        await db.execute('ALTER TABLE live_announcements ADD COLUMN last_viewer_count INT UNSIGNED NULL');
        console.log('[migrate 355] live_announcements.last_viewer_count added');
    }
    if (!(await hasColumn(db, 'live_announcements', 'peak_viewer_count'))) {
        await db.execute('ALTER TABLE live_announcements ADD COLUMN peak_viewer_count INT UNSIGNED NULL');
        console.log('[migrate 355] live_announcements.peak_viewer_count added');
    }
    if (!(await hasColumn(db, 'live_announcements', 'last_edited_at'))) {
        await db.execute('ALTER TABLE live_announcements ADD COLUMN last_edited_at TIMESTAMP NULL');
        console.log('[migrate 355] live_announcements.last_edited_at added');
    }
}
