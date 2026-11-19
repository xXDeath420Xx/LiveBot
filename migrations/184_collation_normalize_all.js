/**
 * Migration 184: Normalize every table to utf8mb4_unicode_ci
 *
 * ## Why this is needed — a regression migration 179 introduced
 *
 * 179 converted the 128 legacy utf8mb3 tables to utf8mb4_unicode_ci. Its
 * discovery query was `table_collation NOT LIKE 'utf8mb4%'`, which by design
 * skipped anything already on utf8mb4 — including the 274 tables sitting on
 * utf8mb4_**general_ci**.
 *
 * That was wrong. It left the schema split down the middle: 565 tables on
 * unicode_ci, 274 on general_ci, with 29 table families straddling the boundary
 * (cfx_* 106 tables, user_* 17, guild_* 14, music_* 14, …). MySQL refuses to
 * compare VARCHARs of different collations, so any JOIN across that boundary
 * throws:
 *
 *     Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and
 *     (utf8mb4_general_ci,IMPLICIT) for operation '='
 *
 * This is not theoretical. /sprites/browse started returning 500 on 2026-08-02
 * for exactly this reason, and migration 183 patched the epic_sprite_* family by
 * hand. 183 fixed one family; this fixes the other 28 and removes the class.
 *
 * ## Why unicode_ci is the target rather than general_ci
 *
 * Both are valid; the split is the problem, not the choice. unicode_ci wins
 * because it sorts and compares correctly for non-English text, which matters
 * now that the network ships es-ES/pt-BR/fr/de locales — general_ci gets
 * accented characters wrong. It is also what 179 and 183 already moved 565
 * tables to, so it is the cheaper direction.
 *
 * ## The real risk, and how it is handled
 *
 * unicode_ci treats more character pairs as equal than general_ci does. A table
 * with a UNIQUE index can therefore hold two rows that are distinct under
 * general_ci but duplicates under unicode_ci, and the ALTER fails with
 * ER_DUP_ENTRY. That is a data problem, not a schema problem, and it must not be
 * papered over — so per-table failures are collected and reported with the
 * offending key rather than aborting the run or being swallowed. Everything that
 * can convert does; anything that cannot is named for a human.
 *
 * Ordering is smallest-table-first so a failure surfaces early and cheaply
 * rather than after rebuilding indexes on a 1.2M-row table.
 */

const TARGET_CHARSET = 'utf8mb4';
const TARGET_COLLATION = 'utf8mb4_unicode_ci';

export async function up(pool) {
    const [tables] = await pool.execute(
        `SELECT table_name AS tableName, table_rows AS approxRows, table_collation AS collation
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_type = 'BASE TABLE'
            AND table_collation <> ?
          ORDER BY table_rows ASC`,
        [TARGET_COLLATION]
    );

    if (tables.length === 0) {
        console.log('[Migration 184] Every table is already utf8mb4_unicode_ci — nothing to do.');
        return;
    }

    console.log(`[Migration 184] Normalizing ${tables.length} table(s) to ${TARGET_COLLATION}...`);

    const converted = [];
    const failed = [];

    for (const { tableName, approxRows } of tables) {
        try {
            await pool.query(
                `ALTER TABLE \`${tableName}\` CONVERT TO CHARACTER SET ${TARGET_CHARSET} COLLATE ${TARGET_COLLATION}`
            );
            converted.push(tableName);

            if (Number(approxRows) > 100000) {
                console.log(`[Migration 184]   ${tableName} (~${approxRows} rows) converted`);
            }
        } catch (error) {
            // ER_DUP_ENTRY here means the table holds rows that only unicode_ci
            // considers equal. Name it — the fix is deduplicating data, which is
            // a decision, not something a migration should make silently.
            failed.push(`${tableName}: [${error.code || 'ERR'}] ${error.message}`);
        }
    }

    console.log(`[Migration 184] Converted ${converted.length} table(s).`);

    if (failed.length) {
        console.error(
            `[Migration 184] ${failed.length} table(s) could NOT be converted and remain on their old collation:\n  ` +
            failed.join('\n  ') +
            '\n  ER_DUP_ENTRY means two rows are distinct under general_ci but equal under unicode_ci. ' +
            'Deduplicate those rows, then re-run this migration.'
        );
    }

    // Report rather than assume: a family still straddling the boundary is the
    // exact condition that produced the /sprites/browse 500.
    const [remaining] = await pool.execute(
        `SELECT COUNT(*) AS n FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_collation <> ?`,
        [TARGET_COLLATION]
    );
    console.log(`[Migration 184] Tables still not on ${TARGET_COLLATION}: ${remaining[0].n}`);
}

/**
 * Not reversible.
 *
 * Going back would mean choosing which of the 839 tables were "originally"
 * general_ci, and that information is gone. It is also not worth recovering:
 * the mixed state is the bug this removes.
 */
export async function down() {
    console.warn('[Migration 184] Down is a no-op — restoring a mixed-collation schema would reintroduce the JOIN failures this fixes.');
}
