/*
 * Migration 319: logging_config.events_saved_at — when the Logging page was last saved.
 *
 * Fifteen Logging-page categories (moderation, xp, tickets, giveaways… — core/log-actions.js
 * OPT_IN_CATEGORIES) had no code behind them until 2026-10-06. Most servers' saved lists had them ticked
 * by the old page's default rather than by choice, so they post only once the page has been saved since
 * (this column set) with them ticked. NULL everywhere at creation: nothing new posts until an admin saves.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'logging_config', 'events_saved_at'))) {
        await db.execute('ALTER TABLE logging_config ADD COLUMN events_saved_at TIMESTAMP NULL DEFAULT NULL');
    }
}

export async function down(db) {
    if (await hasColumn(db, 'logging_config', 'events_saved_at')) {
        await db.execute('ALTER TABLE logging_config DROP COLUMN events_saved_at');
    }
}
