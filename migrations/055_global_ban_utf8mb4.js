/**
 * Migration 055: Convert global_ban tables to utf8mb4
 *
 * All 7 global_ban_* tables use utf8mb3 which cannot store 4-byte Unicode
 * characters (emojis). Report messages from Discord often contain emojis,
 * causing INSERT failures like:
 *   "Incorrect string value: '\xF0\x9F\x99\x84...' for column `reason`"
 *
 * CONVERT TO CHARACTER SET converts the table default AND all existing
 * string/text columns in a single statement.
 */
const TABLES = [
    'global_ban_entries',
    'global_ban_action_log',
    'global_ban_appeals',
    'global_ban_auto_aggregate',
    'global_ban_config',
    'global_ban_reports',
    'global_ban_votes',
];

export async function up(pool) {
    for (const table of TABLES) {
        await pool.execute(
            `ALTER TABLE ${table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
    }
}

export async function down(pool) {
    for (const table of TABLES) {
        await pool.execute(
            `ALTER TABLE ${table} CONVERT TO CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci`
        );
    }
}
