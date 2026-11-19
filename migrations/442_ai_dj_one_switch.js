/**
 * Migration 442 — one AI DJ switch and real defaults (register H-667).
 *
 * 1. ai_dj_config.enabled is now the only AI DJ switch. The Music page's switch used to read
 *    music_config.dj_enabled while /music dj and the AI DJ page used ai_dj_config.enabled, so a server
 *    could see "on" on one page and be refused by the command. Servers whose Music page switch was on
 *    but which had no ai_dj_config row get one, switched on, so nothing an admin turned on goes off.
 *    music_config.dj_enabled stays as a column but nothing reads it any more.
 * 2. ai_dj_config.randomness_level defaulted to 50 on a 0-10 field, and every value but 5 is added to
 *    the DJ's prompt. A value above 10 can only be that default, so it becomes 5 (adds nothing), and the
 *    column default is 5.
 * 3. music_config.dj_voice 'female' / 'male' were placeholders, not voices; the DJ already spoke them as
 *    Amy (core/dj-manager.cjs PIPER_DEFAULT_MODEL). They become 'amy', which is also the new default.
 *
 * Idempotent: the insert skips servers that have a row, the updates only touch out-of-range values.
 */
export async function up(db) {
    await db.query(`
        INSERT IGNORE INTO ai_dj_config (guild_id, enabled, randomness_level)
        SELECT m.guild_id, 1, 5
          FROM music_config m
          LEFT JOIN ai_dj_config a ON a.guild_id = m.guild_id
         WHERE m.dj_enabled = 1 AND a.guild_id IS NULL`);

    await db.query('ALTER TABLE ai_dj_config ALTER COLUMN randomness_level SET DEFAULT 5');
    await db.query('UPDATE ai_dj_config SET randomness_level = 5 WHERE randomness_level > 10 OR randomness_level < 0');

    await db.query("ALTER TABLE music_config ALTER COLUMN dj_voice SET DEFAULT 'amy'");
    await db.query("UPDATE music_config SET dj_voice = 'amy' WHERE dj_voice IN ('female', 'male', '')");
}

export async function down(db) {
    // The inserted rows and the converted values cannot be told apart from later edits; only the defaults go back.
    await db.query('ALTER TABLE ai_dj_config ALTER COLUMN randomness_level SET DEFAULT 50');
    await db.query("ALTER TABLE music_config ALTER COLUMN dj_voice SET DEFAULT 'female'");
}
