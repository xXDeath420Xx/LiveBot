/*
 * Migration 289: /privacy self-service.
 *
 * The privacy tables already exist and are empty — user_privacy_settings (opt-outs),
 * user_consents (unique per user + consent_type) and privacy_actions_log (action_type
 * 'export' | 'delete' | 'view' | 'update', details JSON) — and their shapes fit
 * core/privacy-manager.js as they are, so nothing is created here.
 *
 * What is missing is an index: opting out of message logging and /privacy delete remove a member's
 * cached messages with `DELETE FROM message_logs WHERE author_id = ?`, and /privacy export reads
 * them the same way. message_logs (~100k rows) is indexed on guild, message id and timestamp
 * only, so each of those was a full scan. author_id is VARCHAR(255) holding 17-20 digit
 * snowflakes; a 20-character prefix index is exact for them and small.
 *
 * Idempotent. Built online where the server allows it. Apply directly: import { up } and call up(pool).
 */

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (await hasIndex(db, 'message_logs', 'idx_author')) return;
    try {
        await db.execute('ALTER TABLE message_logs ADD INDEX idx_author (author_id(20)), ALGORITHM=INPLACE, LOCK=NONE');
    } catch (error) {
        console.warn(`[Migration 289] Online index build refused (${error.message}); building normally`);
        await db.execute('ALTER TABLE message_logs ADD INDEX idx_author (author_id(20))');
    }
}

export async function down(db) {
    if (await hasIndex(db, 'message_logs', 'idx_author')) {
        await db.execute('ALTER TABLE message_logs DROP INDEX idx_author');
    }
}
