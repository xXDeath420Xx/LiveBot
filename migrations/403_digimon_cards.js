/**
 * Wave 403 — Digimon Card Game data on digimon_data, filled by scripts/import-digimon-cards.mjs from
 * digimoncard.io. Battles follow the card game: DP decides them, and card keywords (Blocker, Security A., …)
 * change how a match plays.
 *
 *   card_dp         median DP over the Digimon's printings; NULL when it has no card (battles use LEVEL_DP)
 *   card_level      card level (3 Rookie … 6 Mega, 7 for a few); NULL when no card
 *   card_color      most common card colour
 *   card_keywords   JSON list of keywords its cards have outright (CARD_KEYWORDS in core/digimon-logic.js)
 *   card_inherited  JSON list of keywords in its inherited effects, which pass to the forms it digivolves into
 *   card_dps        JSON list of the distinct DP of its printings: a wild one fights with any of them
 *   card_match      how the card was found: exact, alias or base (its name without a bracketed variant)
 */
const COLUMNS = [
    ['card_dp', 'INT NULL DEFAULT NULL'],
    ['card_level', 'TINYINT NULL DEFAULT NULL'],
    ['card_color', 'VARCHAR(40) NULL DEFAULT NULL'],
    ['card_keywords', 'TEXT NULL DEFAULT NULL'],
    ['card_inherited', 'TEXT NULL DEFAULT NULL'],
    ['card_dps', 'TEXT NULL DEFAULT NULL'],
    ['card_match', 'VARCHAR(8) NULL DEFAULT NULL'],
];

export async function up(pool) {
    for (const [name, def] of COLUMNS) {
        const [cols] = await pool.query(`SHOW COLUMNS FROM digimon_data LIKE '${name}'`);
        if (!cols.length) await pool.query(`ALTER TABLE digimon_data ADD COLUMN ${name} ${def}`);
    }
}

export async function down(pool) {
    for (const [name] of [...COLUMNS].reverse()) await pool.query(`ALTER TABLE digimon_data DROP COLUMN ${name}`);
}
