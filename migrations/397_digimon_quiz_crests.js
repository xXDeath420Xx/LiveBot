/**
 * Wave 397 — the daily Digimon quiz also scores a Crest and a creature family; keep both with the result so
 * a repeat view and the dashboard show what the member actually got. Older rows stay NULL.
 */
export async function up(pool) {
    const [cols] = await pool.query('SHOW COLUMNS FROM digimon_quiz_results');
    const have = new Set(cols.map(c => c.Field));
    if (!have.has('crest')) await pool.query('ALTER TABLE digimon_quiz_results ADD COLUMN crest VARCHAR(16) NULL AFTER level');
    if (!have.has('family')) await pool.query('ALTER TABLE digimon_quiz_results ADD COLUMN family VARCHAR(16) NULL AFTER crest');
}

export async function down(pool) {
    await pool.query('ALTER TABLE digimon_quiz_results DROP COLUMN family, DROP COLUMN crest');
}
