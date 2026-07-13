/**
 * Migration 107: Add Many Decks (decks.rereadgames.com) as a deck source.
 *
 * - Adds 'manydecks' to cah_decks.source ENUM
 * - Drops the standalone UNIQUE(cast_id) and replaces with UNIQUE(source, cast_id)
 *   so a 5-char code that coincidentally exists on both CAST and Many Decks
 *   can be imported as two distinct decks.
 */

async function indexExists(db, table, indexName) {
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, indexName]
    );
    return rows[0].n > 0;
}

async function columnHasEnum(db, table, column, enumValue) {
    const [rows] = await db.execute(
        `SELECT column_type FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
    );
    if (rows.length === 0) return false;
    return rows[0].column_type.includes(`'${enumValue}'`);
}

export async function up(db) {
    // 1. Extend the ENUM (idempotent)
    if (!(await columnHasEnum(db, 'cah_decks', 'source', 'manydecks'))) {
        await db.execute(
            `ALTER TABLE cah_decks MODIFY COLUMN source ENUM('cast','builtin','custom','manydecks') NOT NULL`
        );
    }

    // 2. Swap the unique constraint to a composite (source, cast_id)
    if (await indexExists(db, 'cah_decks', 'uq_cast_id')) {
        await db.execute(`ALTER TABLE cah_decks DROP INDEX uq_cast_id`);
    }
    if (!(await indexExists(db, 'cah_decks', 'uq_source_cast'))) {
        await db.execute(`ALTER TABLE cah_decks ADD UNIQUE KEY uq_source_cast (source, cast_id)`);
    }
}

export async function down(db) {
    if (await indexExists(db, 'cah_decks', 'uq_source_cast')) {
        await db.execute(`ALTER TABLE cah_decks DROP INDEX uq_source_cast`);
    }
    if (!(await indexExists(db, 'cah_decks', 'uq_cast_id'))) {
        await db.execute(`ALTER TABLE cah_decks ADD UNIQUE KEY uq_cast_id (cast_id)`);
    }
    await db.execute(`ALTER TABLE cah_decks MODIFY COLUMN source ENUM('cast','builtin','custom') NOT NULL`);
}
