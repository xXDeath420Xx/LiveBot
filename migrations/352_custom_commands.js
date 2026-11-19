/**
 * Migration 352 — Custom Commands + per-user KV store (YAGPDB-style, compact subset).
 *
 * One row per custom command per guild. A guild admin creates them via /cc add
 * and members trigger them via /cc run (or an auto-trigger on message prefix in
 * a follow-up build). Templates support a safe subset: {{user}}, {{user.mention}},
 * {{server}}, {{channel}}, {{random:a,b,c}}, {{db:get:key}}, {{db:set:key:value}},
 * {{db:incr:key}}. No HTTP, no regex, no scheduling in this MVP.
 *
 * custom_commands_kv is per-guild per-user per-key, like YAGPDB's dbSet/dbGet.
 * Values are TEXT; integers stored as decimal strings so dbIncr can be atomic
 * via SQL (ON DUPLICATE KEY UPDATE value_text = value_text + 1).
 *
 * Idempotent.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'custom_commands'))) {
        await db.execute(`
            CREATE TABLE custom_commands (
                id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                guild_id       VARCHAR(20)     NOT NULL,
                name           VARCHAR(32)     NOT NULL,
                body           MEDIUMTEXT      NOT NULL,
                response_type  ENUM('text','embed') NOT NULL DEFAULT 'text',
                enabled        TINYINT(1)      NOT NULL DEFAULT 1,
                created_by     VARCHAR(20)     NULL,
                run_count      INT UNSIGNED    NOT NULL DEFAULT 0,
                last_run_at    TIMESTAMP       NULL,
                created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_name (guild_id, name),
                KEY idx_guild (guild_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
        console.log('[migrate 352] created custom_commands');
    }
    if (!(await hasTable(db, 'custom_commands_kv'))) {
        await db.execute(`
            CREATE TABLE custom_commands_kv (
                guild_id    VARCHAR(20)  NOT NULL,
                user_id     VARCHAR(20)  NOT NULL,
                key_name    VARCHAR(100) NOT NULL,
                value_text  TEXT         NULL,
                updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, user_id, key_name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
        console.log('[migrate 352] created custom_commands_kv');
    }
}
