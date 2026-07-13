/**
 * Migration 108: User-authored CAH decks.
 *
 * Adds two columns to `cah_decks` so users can own + share custom packs:
 *   - owner_user_id   VARCHAR(20)  — Discord user id of the deck author
 *   - is_public       TINYINT(1)   — 1 = appears in everyone's deck picker;
 *                                    0 = only the owner sees it (or anyone
 *                                    with the share code)
 *
 * Owner uses Discord OAuth id space, same as cah_game_players. We reuse the
 * existing `cast_id` column to store the share code for custom decks — the
 * uq_source_cast composite index from migration 107 keeps them unique per
 * source, so a 'custom' deck with code "ABC12" doesn't collide with a 'cast'
 * deck of the same code.
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
    if (!(await columnExists(db, 'cah_decks', 'owner_user_id'))) {
        await db.execute(
            `ALTER TABLE cah_decks ADD COLUMN owner_user_id VARCHAR(20) NULL AFTER imported_by_user_id,
             ADD INDEX idx_owner (owner_user_id)`
        );
    }
    if (!(await columnExists(db, 'cah_decks', 'is_public'))) {
        await db.execute(
            `ALTER TABLE cah_decks ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 1 AFTER nsfw`
        );
    }
}

export async function down(db) {
    if (await columnExists(db, 'cah_decks', 'owner_user_id')) {
        await db.execute(`ALTER TABLE cah_decks DROP INDEX idx_owner, DROP COLUMN owner_user_id`);
    }
    if (await columnExists(db, 'cah_decks', 'is_public')) {
        await db.execute(`ALTER TABLE cah_decks DROP COLUMN is_public`);
    }
}
