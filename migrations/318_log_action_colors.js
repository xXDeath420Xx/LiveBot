/*
 * Migration 318: log_action_colors — the colour a server picked for one log ACTION.
 *
 * The Logging page offered one colour per category (log_event_config.embed_color), which cannot describe a
 * category whose actions are coloured differently (voice Join / Leave / Move) and was never applied by the
 * bot. Colours are now per action (core/log-actions.js lists every action and its default); this table
 * holds only the ones an admin changed, and sendLogEmbed applies them. log_event_config.embed_color stays
 * as legacy data and is no longer read or written.
 *
 *   guild_id  VARCHAR(20)  the server
 *   action    VARCHAR(48)  action key, e.g. 'voiceUpdate.join', 'messageUpdate'
 *   color     CHAR(7)      '#RRGGBB'
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS log_action_colors (
            guild_id   VARCHAR(20) NOT NULL,
            action     VARCHAR(48) NOT NULL,
            color      CHAR(7)     NOT NULL,
            updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, action)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS log_action_colors');
}
