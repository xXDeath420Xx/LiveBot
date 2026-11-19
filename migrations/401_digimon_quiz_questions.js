/**
 * Wave 401 — digimon_quiz_questions: a server's own quiz questions and its changes to the built-in ones.
 *
 * builtin_index set   → replaces QUESTION_BANK[builtin_index] in that server (new wording/tags), or turns it
 *                       off when enabled = 0. One row per built-in per server.
 * builtin_index NULL  → a question the server wrote.
 * options is the answers as JSON text ([{ label, a, f, t, c, p }]); TEXT, not JSON, because mysql2 above 3.22
 * changes how JSON columns come back. Read through buildBank in core/digimon-quiz.js.
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS digimon_quiz_questions (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(25) NOT NULL,
            builtin_index SMALLINT UNSIGNED NULL DEFAULT NULL,
            cat VARCHAR(32) NOT NULL,
            q VARCHAR(400) NOT NULL,
            options TEXT NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_guild_builtin (guild_id, builtin_index),
            KEY idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS digimon_quiz_questions');
}
