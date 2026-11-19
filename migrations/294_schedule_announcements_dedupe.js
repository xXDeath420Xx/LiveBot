/*
 * Migration 294: make schedule_announcements a real dedupe ledger.
 *
 * `/schedule link type:announcements` has always stored update_type, announce_before_minutes and
 * role_to_ping on schedule_linked_channels, but core/schedule-manager.js only ever drew the ticker.
 * It now posts "starting soon", "now playing" and "completed" messages per run into the linked
 * channel. Each (linked channel, run, announcement type) must be posted exactly once even though
 * the ticker loop runs every minute on every bot client — so the post is CLAIMED first with
 * INSERT IGNORE, and only the caller whose insert landed sends it. That needs a unique key; the
 * table only had plain indexes. It has never held a row, so adding the key cannot fail on
 * duplicates.
 *
 * Apply directly: import { up } and call up(pool).
 */
async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasIndex(db, 'schedule_announcements', 'uniq_link_item_type'))) {
        await db.execute(
            'ALTER TABLE schedule_announcements ADD UNIQUE KEY uniq_link_item_type (linked_channel_id, item_id, announcement_type)'
        );
    }
}

export async function down(db) {
    if (await hasIndex(db, 'schedule_announcements', 'uniq_link_item_type')) {
        await db.execute('ALTER TABLE schedule_announcements DROP INDEX uniq_link_item_type');
    }
}
