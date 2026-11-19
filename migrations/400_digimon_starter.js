/**
 * Wave 400 — user_digimon.starter: the starter line a member picked in /digimon start (STARTERS in
 * core/digimon-logic.js). Up to Child the Digimon grows along that line; NULL means a random egg or a
 * Digimon that did not hatch from a starter egg, and care decides every stage.
 */
export async function up(pool) {
    const [cols] = await pool.query(`SHOW COLUMNS FROM user_digimon LIKE 'starter'`);
    if (!cols.length) await pool.query('ALTER TABLE user_digimon ADD COLUMN starter VARCHAR(32) NULL DEFAULT NULL AFTER is_partner');
}

export async function down(pool) {
    await pool.query('ALTER TABLE user_digimon DROP COLUMN starter');
}
