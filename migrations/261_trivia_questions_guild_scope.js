/*
 * Migration 261: trivia_questions.guild_id — server-specific trivia questions.
 *
 * WHY
 * ---
 * The dashboard lets a server add its own trivia questions, but `trivia_questions` had no way to
 * say which server a question belongs to, so the add form failed and `/arcade trivia start`
 * (core/trivia-manager.js) could only ever see the shared bank.
 *
 * WHAT
 * ----
 *  - guild_id VARCHAR(20) NULL — NULL = global question (the existing 110 rows stay global),
 *    otherwise the server that added it. Readers select `guild_id IS NULL OR guild_id = ?`.
 *  - idx_guild (guild_id).
 *
 * Idempotent: both are added only when missing (information_schema).
 */

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]);
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, index]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'trivia_questions', 'guild_id'))) {
        await db.execute('ALTER TABLE trivia_questions ADD COLUMN guild_id VARCHAR(20) NULL DEFAULT NULL');
    }
    if (!(await hasIndex(db, 'trivia_questions', 'idx_guild'))) {
        await db.execute('ALTER TABLE trivia_questions ADD INDEX idx_guild (guild_id)');
    }
}

export async function down(db) {
    if (await hasIndex(db, 'trivia_questions', 'idx_guild')) {
        await db.execute('ALTER TABLE trivia_questions DROP INDEX idx_guild');
    }
    if (await hasColumn(db, 'trivia_questions', 'guild_id')) {
        // Server-specific questions would become global if kept, so remove them with the column.
        await db.execute('DELETE FROM trivia_questions WHERE guild_id IS NOT NULL');
        await db.execute('ALTER TABLE trivia_questions DROP COLUMN guild_id');
    }
}
