/*
 * Migration 285: deleted-image evidence.
 *
 * message_logs.attachment_urls has been stored for every cached message with attachments, but the
 * delete log never showed it, and by the time a message is deleted its Discord CDN links are dead.
 * core/evidence-capture.js now keeps a private copy of each image when the message is posted and
 * re-hosts it into an evidence channel when the message is deleted. Off by default; a server turns
 * it on from the dashboard ("Deleted-image evidence" card).
 *
 *   logging_config.evidence_capture_enabled   0/1, default 0 (opt-in per guild)
 *   logging_config.evidence_channel_id        where re-hosted images go; NULL = the message-delete
 *                                             log channel
 *   logging_config.evidence_max_mb            per-image size limit, NULL = 8 MB (clamped 1-25)
 *
 *   message_attachments (existing, empty; FK to message_logs ON DELETE CASCADE) gains:
 *     attachment_id         Discord attachment id — with message_log_id, unique, so a message
 *                           saved twice (create + edit, or seed) records each attachment once
 *     cache_path            local copy, relative to data/evidence-cache/ (NULL once re-hosted/pruned)
 *     evidence_channel_id / evidence_message_id   where the re-hosted copy lives
 *     captured_at / rehosted_at
 *   stored_url (existing) holds the re-hosted attachment URL.
 *
 * Idempotent: every ADD is guarded by information_schema. Apply directly: import { up } and
 * call up(pool).
 */

const COLUMNS = [
    ['logging_config', 'evidence_capture_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['logging_config', 'evidence_channel_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['logging_config', 'evidence_max_mb', 'INT NULL DEFAULT NULL'],
    ['message_attachments', 'attachment_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['message_attachments', 'cache_path', 'VARCHAR(255) NULL DEFAULT NULL'],
    ['message_attachments', 'evidence_channel_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['message_attachments', 'evidence_message_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['message_attachments', 'captured_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP'],
    ['message_attachments', 'rehosted_at', 'TIMESTAMP NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }
    if (!(await hasIndex(db, 'message_attachments', 'uniq_log_attachment'))) {
        await db.execute('ALTER TABLE message_attachments ADD UNIQUE KEY uniq_log_attachment (message_log_id, attachment_id)');
    }
}

export async function down(db) {
    if (await hasIndex(db, 'message_attachments', 'uniq_log_attachment')) {
        await db.execute('ALTER TABLE message_attachments DROP INDEX uniq_log_attachment');
    }
    for (const [table, column] of [...COLUMNS].reverse()) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
