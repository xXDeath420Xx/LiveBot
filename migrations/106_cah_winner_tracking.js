/**
 * Migration 106: cah_games.winner_user_ids
 *
 * Backfills a JSON column with the final winner ids of each game so the
 * leaderboard can aggregate without parsing settings_json or state_json.
 * Engine writes this on endGame().
 */
async function columnExists(db, table, column) {
    const allowed = new Set(['cah_games']);
    if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = ?`,
        [column]
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await columnExists(db, 'cah_games', 'winner_user_ids'))) {
        await db.execute(`ALTER TABLE cah_games ADD COLUMN winner_user_ids JSON NULL AFTER state_json`);
    }
}

export async function down(db) {
    if (await columnExists(db, 'cah_games', 'winner_user_ids')) {
        await db.execute(`ALTER TABLE cah_games DROP COLUMN winner_user_ids`);
    }
}
