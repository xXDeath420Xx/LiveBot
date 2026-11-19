/**
 * Wave 402 — Digimon teams, V-Pet lifespans, de-digivolving and DNA Digivolution.
 *
 *   team_slot       1-3 on the member's team (1 leads), NULL in the DigiBank. is_partner stays and means
 *                   "on the team", so every older query that reads it keeps working.
 *   forms           JSON {stage: digimon_id} of every form this Digimon has reached, so it can de-digivolve
 *                   and digivolve back into the same forms.
 *   generation      1 for a new Digimon, +1 each time it is reborn from its Digi-Egg.
 *   total_mistakes  care mistakes over its whole life (care_mistakes is per stage); shortens its lifespan.
 *   age_ms/aged_at  time spent on the team; the DigiBank does not age.
 *   dna_partner_id  the Digimon it is DNA-fused with (that one is locked = 'dna'); dna_stage is the stage the
 *                   fusion made, and de-digivolving below it splits them again.
 *   digimon_settings.lifespan_days  days on the team before a partner returns to a Digi-Egg; 0 turns it off.
 *   digimon_dna     the DNA Digivolutions the data names: from_id + with_id → to_id, read from digi-api's
 *                   evolution conditions ("with Stingmon") by scripts/import-digimon-dna.mjs.
 *
 * Existing partners become their member's team leader, and every Digimon's forms start with its current one.
 */
const COLUMNS = [
    ['team_slot', 'TINYINT NULL DEFAULT NULL AFTER is_partner'],
    ['forms', 'TEXT NULL DEFAULT NULL AFTER starter'],
    ['generation', 'INT NOT NULL DEFAULT 1 AFTER forms'],
    ['total_mistakes', 'INT NOT NULL DEFAULT 0 AFTER care_mistakes'],
    ['age_ms', 'BIGINT NOT NULL DEFAULT 0 AFTER last_trained_at'],
    ['aged_at', 'BIGINT NULL DEFAULT NULL AFTER age_ms'],
    ['dna_partner_id', 'INT NULL DEFAULT NULL AFTER aged_at'],
    ['dna_stage', 'VARCHAR(12) NULL DEFAULT NULL AFTER dna_partner_id'],
];

export async function up(pool) {
    for (const [name, def] of COLUMNS) {
        const [cols] = await pool.query(`SHOW COLUMNS FROM user_digimon LIKE '${name}'`);
        if (!cols.length) await pool.query(`ALTER TABLE user_digimon ADD COLUMN ${name} ${def}`);
    }
    const [life] = await pool.query(`SHOW COLUMNS FROM digimon_settings LIKE 'lifespan_days'`);
    if (!life.length) await pool.query('ALTER TABLE digimon_settings ADD COLUMN lifespan_days INT NOT NULL DEFAULT 30');
    await pool.query(`CREATE TABLE IF NOT EXISTS digimon_dna (
        from_id INT NOT NULL, with_id INT NOT NULL, to_id INT NOT NULL,
        PRIMARY KEY (from_id, with_id, to_id), KEY idx_to (to_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3`);

    const now = Date.now();
    await pool.query('UPDATE user_digimon SET team_slot = 1, aged_at = ? WHERE is_partner = 1 AND team_slot IS NULL', [now]);
    await pool.query(
        `UPDATE user_digimon u JOIN digimon_data d ON d.id = u.digimon_id
            SET u.forms = JSON_OBJECT(d.level, u.digimon_id)
          WHERE u.forms IS NULL`);
    await pool.query('UPDATE user_digimon SET total_mistakes = care_mistakes WHERE total_mistakes = 0 AND care_mistakes > 0');
}

export async function down(pool) {
    for (const [name] of [...COLUMNS].reverse()) await pool.query(`ALTER TABLE user_digimon DROP COLUMN ${name}`);
    await pool.query('ALTER TABLE digimon_settings DROP COLUMN lifespan_days');
    await pool.query('DROP TABLE IF EXISTS digimon_dna');
}
