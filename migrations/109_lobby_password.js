/**
 * Migration 109: Password-protected CAH lobbies.
 *
 * Adds password_hash to cah_games — nullable, so games without a password
 * stay null. Hash is SHA-256(password + ':' + game_uuid) — the game UUID is
 * the per-row salt so an attacker with the DB still has to brute-force per
 * game. Plain passwords are also kept in-memory by the engine for fast checks;
 * the hash is only used to restore + verify after a process restart.
 */
async function columnExists(db, table, column) {
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await columnExists(db, 'cah_games', 'password_hash'))) {
        await db.execute(`ALTER TABLE cah_games ADD COLUMN password_hash CHAR(64) NULL AFTER state_json`);
    }
}

export async function down(db) {
    if (await columnExists(db, 'cah_games', 'password_hash')) {
        await db.execute(`ALTER TABLE cah_games DROP COLUMN password_hash`);
    }
}
