/**
 * Wave 377 — inactivity-prune per-feature user allowlist. Separate from the global
 * protection_allowlist (which exempts a user from EVERY automated action); this
 * one only skips the inactivity sweep. JSON array of snowflake ids.
 */
export async function up(pool) {
    const [exists] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'join_gate_config' AND COLUMN_NAME = 'inactive_exempt_users'`);
    if (!exists[0].n) {
        await pool.query(`
            ALTER TABLE join_gate_config
            ADD COLUMN inactive_exempt_users TEXT DEFAULT NULL
        `);
    }
}

export async function down(pool) {
    await pool.query('ALTER TABLE join_gate_config DROP COLUMN inactive_exempt_users');
}
