/**
 * Wave 404 — digimon_inventory.starters_claimed: how many starter Digi-Eggs a member has taken from /digimon start.
 * A member picks three (STARTER_EGGS in core/digimon-logic.js), all at once or over several runs.
 *
 * Backfill: everyone who already ran /digimon start took one egg under the old one-egg rule, so they get 1 and
 * can come back for the other two.
 */
export async function up(pool) {
    const [cols] = await pool.query(`SHOW COLUMNS FROM digimon_inventory LIKE 'starters_claimed'`);
    if (cols.length) return;
    await pool.query(`ALTER TABLE digimon_inventory ADD COLUMN starters_claimed TINYINT NOT NULL DEFAULT 0`);
    // /digimon start was the only way in before this, and it refused anyone who had a Digimon.
    await pool.query(`INSERT IGNORE INTO digimon_inventory (guild_id, user_id) SELECT DISTINCT guild_id, user_id FROM user_digimon`);
    await pool.query(`UPDATE digimon_inventory i SET starters_claimed = 1
                       WHERE EXISTS (SELECT 1 FROM user_digimon u WHERE u.guild_id = i.guild_id AND u.user_id = i.user_id)`);
}
