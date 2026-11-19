/*
 * Store the per-guild GENERATED questionnaire alongside the profile.
 *
 * The takeover questionnaire used to be a single hardcoded list (core/takeover-questions.js), written
 * for one server. It is now generated per guild from that guild's own scan. Because the questionnaire
 * is also the validation whitelist for a public, unauthenticated form, the generated set must live
 * server-side — this column is where the server keeps the exact set it authored for each guild.
 */
export async function up(db) {
  await db.execute(`
    ALTER TABLE takeover_profiles
    ADD COLUMN IF NOT EXISTS questionnaire_json LONGTEXT NULL AFTER data,
    ADD COLUMN IF NOT EXISTS questionnaire_generated_at TIMESTAMP NULL AFTER questionnaire_json
  `);
}

export async function down(db) {
  await db.execute(`
    ALTER TABLE takeover_profiles
    DROP COLUMN IF EXISTS questionnaire_json,
    DROP COLUMN IF EXISTS questionnaire_generated_at
  `);
}

export default { up, down };
