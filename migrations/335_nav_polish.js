/*
 * Migration 335: navigation polish (wave 17).
 *
 *   user_preferences.ui_options   NEW column, JSON. Small per-user dashboard switches that do not
 *                                 deserve a column each (core/user-preferences.js parseUiOptions):
 *                                   serverAccent       tint a server's manage pages with its embed colour
 *                                   hiddenChecklists   guild ids whose overview setup checklist was dismissed
 *                                 NULL = every default (off / nothing hidden).
 *   guild_feature_config (fun)    DATA. /fun insult's "Evil Insult API" source is gone (evilinsult.com
 *                                 answers servers with a Cloudflare bot challenge, so it never worked);
 *                                 any saved insult_source other than 'builtin' is set back to 'builtin'.
 *
 * Idempotent: the column is added once, the data fix only touches rows that still need it.
 * down() drops the column (the insult data fix is not reversed: the old value cannot work).
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export const ADD_COLUMN = 'ALTER TABLE user_preferences ADD COLUMN ui_options LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL CHECK (json_valid(ui_options)) AFTER hidden_sections';
export const DROP_COLUMN = 'ALTER TABLE user_preferences DROP COLUMN ui_options';
export const FIX_INSULT_SOURCE = `UPDATE guild_feature_config
    SET config = JSON_SET(config, '$.insult_source', 'builtin')
    WHERE feature_key = 'fun'
      AND JSON_EXISTS(config, '$.insult_source')
      AND JSON_UNQUOTE(JSON_EXTRACT(config, '$.insult_source')) <> 'builtin'`;

export async function up(db) {
    if (!(await hasColumn(db, 'user_preferences', 'ui_options'))) await db.execute(ADD_COLUMN);
    await db.execute(FIX_INSULT_SOURCE);
}

export async function down(db) {
    if (await hasColumn(db, 'user_preferences', 'ui_options')) await db.execute(DROP_COLUMN);
}

export default { up, down };
