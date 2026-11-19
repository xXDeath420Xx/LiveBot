/**
 * Migration 179: Convert legacy utf8mb3 tables to utf8mb4
 *
 * 128 tables were created as utf8mb3 (MySQL's old 3-byte "utf8"), which cannot
 * store any character outside the BMP — which means it cannot store emoji.
 * Writing an emoji into one of these columns either throws
 * ER_TRUNCATED_WRONG_VALUE_FOR_FIELD or silently mangles the value depending on
 * strict mode. On a Discord bot that is not an edge case: it affects
 * guild_command_restrictions, orientation_config, adaptive_spam_config,
 * commission_spam_config and most of the cfx_* economy tables.
 *
 * Safety notes:
 *  - Discovery is done at runtime rather than from a hardcoded list, so this is
 *    idempotent and stays correct if tables were added/converted since.
 *  - utf8mb4 costs 4 bytes/char vs 3, which can push a VARCHAR index over
 *    InnoDB's 3072-byte limit. Checked before writing this: zero at-risk
 *    indexes exist inside the conversion set (the eight indexes network-wide
 *    that would exceed 3072B are all on tables that are already utf8mb4).
 *    The check is repeated at runtime anyway and skips rather than aborts.
 *  - ~392k rows total, of which phishing_domains is 385k. Everything else is
 *    tiny. Conversion locks per-table, so the practical cost is one table.
 *  - Per-table failures are collected and reported rather than aborting the
 *    run, so one bad table cannot leave the other 127 half-converted.
 *
 * utf8mb4_unicode_ci is chosen over utf8mb4_general_ci for correct multilingual
 * collation, which matters once Phase 3 (i18n) lands.
 */

const TARGET_CHARSET = 'utf8mb4';
const TARGET_COLLATION = 'utf8mb4_unicode_ci';
const MAX_INDEX_BYTES = 3072;

async function findLegacyTables(pool, schema) {
    const [rows] = await pool.execute(
        `SELECT table_name AS tableName, table_rows AS approxRows
           FROM information_schema.tables
          WHERE table_schema = ?
            AND table_type = 'BASE TABLE'
            AND table_collation NOT LIKE 'utf8mb4%'
          ORDER BY table_rows ASC`,
        [schema]
    );
    return rows;
}

/**
 * Widest VARCHAR/CHAR index on this table, measured at 4 bytes/char.
 * Returns 0 when the table has no character-column indexes.
 */
async function widestIndexBytes(pool, schema, tableName) {
    const [rows] = await pool.execute(
        `SELECT MAX(total) AS bytes FROM (
           SELECT SUM(c.character_maximum_length * 4) AS total
             FROM information_schema.statistics s
             JOIN information_schema.columns c
               ON c.table_schema = s.table_schema
              AND c.table_name   = s.table_name
              AND c.column_name  = s.column_name
            WHERE s.table_schema = ?
              AND s.table_name = ?
              AND c.data_type IN ('varchar', 'char')
            GROUP BY s.index_name
         ) AS per_index`,
        [schema, tableName]
    );
    return Number(rows[0]?.bytes || 0);
}

export async function up(pool) {
    const [[{ schema }]] = await pool.execute('SELECT DATABASE() AS `schema`');
    const tables = await findLegacyTables(pool, schema);

    if (tables.length === 0) {
        console.log('[Migration 179] No utf8mb3 tables found — nothing to convert.');
        return;
    }

    console.log(`[Migration 179] Converting ${tables.length} tables to ${TARGET_CHARSET}...`);

    const converted = [];
    const skipped = [];
    const failed = [];

    for (const { tableName, approxRows } of tables) {
        try {
            const bytes = await widestIndexBytes(pool, schema, tableName);
            if (bytes > MAX_INDEX_BYTES) {
                skipped.push(`${tableName} (widest char index ${bytes}B > ${MAX_INDEX_BYTES}B)`);
                continue;
            }

            // Backticks only — table names come from information_schema, but this
            // is DDL and cannot be parameterised.
            await pool.query(
                `ALTER TABLE \`${tableName}\` CONVERT TO CHARACTER SET ${TARGET_CHARSET} COLLATE ${TARGET_COLLATION}`
            );
            converted.push(tableName);

            if (Number(approxRows) > 100000) {
                console.log(`[Migration 179]   ${tableName} (~${approxRows} rows) converted`);
            }
        } catch (error) {
            failed.push(`${tableName}: ${error.message}`);
        }
    }

    console.log(`[Migration 179] Converted ${converted.length} tables.`);
    if (skipped.length) {
        console.warn(`[Migration 179] Skipped ${skipped.length} (index width):\n  ${skipped.join('\n  ')}`);
    }
    if (failed.length) {
        console.error(`[Migration 179] Failed ${failed.length}:\n  ${failed.join('\n  ')}`);
        throw new Error(`Migration 179: ${failed.length} table(s) failed to convert — see log above.`);
    }
}

/**
 * Deliberately not reversible.
 *
 * Going back to utf8mb3 would have to destroy any 4-byte character written
 * since the upgrade — MySQL truncates the row at the first astral codepoint.
 * A "down" that silently eats user data is worse than no down at all, so this
 * is a no-op and the rollback path is a restore from backup.
 */
export async function down() {
    console.warn('[Migration 179] Down is a no-op: reverting to utf8mb3 would destroy 4-byte characters. Restore from backup instead.');
}
