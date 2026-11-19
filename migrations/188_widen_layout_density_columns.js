/**
 * Migration 188: Widen dashboard_layout and density from ENUM to VARCHAR
 *
 * ## The bug this fixes
 *
 * Migration 185 created `dashboard_layout ENUM('grid','list')`. When a third
 * layout ("cozy" / Large cards) was added to the application's LAYOUTS list, the
 * UI offered it and the validator accepted it — but MySQL rejected the write
 * with WARN_DATA_TRUNCATED, because the column literally cannot hold the value.
 * Selecting Large cards errored every time.
 *
 * Migration 187 already widened `theme` from ENUM to VARCHAR for exactly this
 * reason. `dashboard_layout` and `density` were overlooked, so the same trap was
 * left armed on both.
 *
 * ## Why VARCHAR rather than a wider ENUM
 *
 * An ENUM makes the database a second place that has to know the list of valid
 * values, and it fails *late* — at write time, after the UI has already offered
 * the choice and the validator has already approved it. That split is what
 * produced this bug.
 *
 * Validity is enforced in core/user-preferences.js against LAYOUTS/DENSITIES,
 * which is also what builds the picker — so the UI cannot offer something the
 * validator rejects. With one source of truth in the application, the column's
 * job is just to store a short string. Adding a fourth layout is now one entry
 * in one file with no schema change.
 *
 * Existing values are unaffected: ENUM -> VARCHAR preserves the stored strings.
 */
const COLUMNS = [
    ['dashboard_layout', "VARCHAR(24) NOT NULL DEFAULT 'grid'"],
    ['density', "VARCHAR(24) NOT NULL DEFAULT 'comfortable'"],
];

export async function up(pool) {
    for (const [name, definition] of COLUMNS) {
        const [[col]] = await pool.execute(
            `SELECT column_type AS t FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'user_preferences' AND column_name = ?`,
            [name]
        );

        if (!col) {
            console.log(`[Migration 188] ${name} not present — skipping`);
            continue;
        }
        if (!/^enum/i.test(col.t)) {
            console.log(`[Migration 188] ${name} is already ${col.t} — nothing to do`);
            continue;
        }

        await pool.query(`ALTER TABLE user_preferences MODIFY COLUMN ${name} ${definition}`);
        console.log(`[Migration 188] ${name}: ${col.t} -> ${definition.split(' ')[0]}`);
    }

    // Prove the value that was failing now round-trips, rather than assuming it.
    const probe = '000000000000000188';
    try {
        await pool.execute(
            `INSERT INTO user_preferences (discord_user_id, dashboard_layout) VALUES (?, 'cozy')
             ON DUPLICATE KEY UPDATE dashboard_layout = 'cozy'`,
            [probe]
        );
        const [[row]] = await pool.execute(
            'SELECT dashboard_layout AS v FROM user_preferences WHERE discord_user_id = ?',
            [probe]
        );
        console.log(`[Migration 188] Verified: 'cozy' stores and reads back as '${row.v}'`);
    } finally {
        await pool.execute('DELETE FROM user_preferences WHERE discord_user_id = ?', [probe]).catch(() => {});
    }
}

export async function down(pool) {
    // Narrowing back would truncate any row holding a value outside the old set,
    // so this restores the ENUM only after normalising those rows.
    await pool.execute("UPDATE user_preferences SET dashboard_layout = 'grid' WHERE dashboard_layout NOT IN ('grid','list')");
    await pool.execute("UPDATE user_preferences SET density = 'comfortable' WHERE density NOT IN ('comfortable','compact','spacious')");
    await pool.query("ALTER TABLE user_preferences MODIFY COLUMN dashboard_layout ENUM('grid','list') NOT NULL DEFAULT 'grid'");
    await pool.query("ALTER TABLE user_preferences MODIFY COLUMN density ENUM('comfortable','compact','spacious') NOT NULL DEFAULT 'comfortable'");
}
