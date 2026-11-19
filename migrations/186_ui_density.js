/**
 * Migration 186: UI density preference
 *
 * Migration 185 added layout and pinning. This adds density, which is separate
 * from both: layout decides the *shape* of the module list (cards vs rows),
 * density decides the *spacing scale* and applies to every page rather than
 * just the overview.
 *
 * `compact_mode` already existed on this table (and, like the rest of it, was
 * read by no code). It is kept and honoured as a legacy boolean — an existing
 * row with compact_mode=1 is migrated to density='compact' below rather than
 * being silently ignored, because the one user who had set it did so meaning it.
 *
 * 'comfortable' is the default and has no block in themes.css, so it is
 * identical to what ships today.
 */
export async function up(pool) {
    try {
        await pool.execute(
            `ALTER TABLE user_preferences
               ADD COLUMN density ENUM('comfortable','compact','spacious')
               NOT NULL DEFAULT 'comfortable'`
        );
        console.log('[Migration 186] Added user_preferences.density');
    } catch (error) {
        if (error.code !== 'ER_DUP_FIELDNAME') throw error;
        console.log('[Migration 186] density already present');
    }

    // Honour the legacy flag rather than stranding it.
    const [result] = await pool.execute(
        `UPDATE user_preferences SET density = 'compact'
          WHERE compact_mode = 1 AND density = 'comfortable'`
    );
    if (result.affectedRows) {
        console.log(`[Migration 186] Migrated ${result.affectedRows} row(s) from compact_mode=1 to density='compact'`);
    }
}

export async function down(pool) {
    await pool.execute('ALTER TABLE user_preferences DROP COLUMN density').catch(() => {});
}
