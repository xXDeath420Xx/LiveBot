/**
 * Migration 433 — permanent command usage tracking (owner request 2026-11-18: "I need more tracking
 * than just 7 days").
 *
 * command_usage          one row per command run, written in batches by core/command-usage.js from
 *                        both dispatch paths: events/interactionCreate.js (slash commands and context
 *                        menus) and the chat bridge (core/universal-commands.js, plus the hand-written
 *                        prefix registry in core/prefix-command-manager.js).
 *   guild_id             '' for a DM
 *   app_id               the bot application that handled it (default bot or one of the custom bots)
 *   command / path       top-level command and full chat path ("music play"); for a moved command this
 *                        is the command's own name, the same key restriction rows use ("owoify", not
 *                        "fun owoify")
 *   kind                 slash (real slash command) · prefix (! ? $ . or @mention) · slash_text (typed as
 *                        "/name" in chat, the text commands of the slash/text split) · context (menus)
 *   prefix               the chat prefix used ('@' for a mention), NULL for slash and context menus
 *   success / error_code whether execute() threw, and the error's code or name
 *   latency_ms           time spent in execute()
 *   Kept 400 days: data_retention_policy row below, enforced nightly by jobs/retention-sweeper.js.
 *   /privacy export lists it (it has user_id) and /privacy delete removes it (core/privacy-tables.js).
 *
 * command_usage_daily    one row per day x server x path x kind x source, rolled up by
 *                        jobs/command-usage-rollup.js. No user ids, so it is kept forever.
 *   source               live (rolled up from command_usage) or where a backfill came from:
 *                        backfill_audit (audit_logs COMMAND_USAGE rows), backfill_log (bot log files),
 *                        backfill_message (deleted/edited chat commands in message_logs). Part of the key,
 *                        so a backfill never overwrites live numbers; reports add the sources up.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS and INSERT IGNORE.
 */
export async function up(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS command_usage (
            id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            guild_id    VARCHAR(20)  NOT NULL DEFAULT '',
            channel_id  VARCHAR(20)  NULL,
            user_id     VARCHAR(20)  NULL,
            app_id      VARCHAR(20)  NULL,
            command     VARCHAR(64)  NOT NULL,
            path        VARCHAR(100) NOT NULL,
            kind        ENUM('slash','prefix','slash_text','context') NOT NULL,
            prefix      VARCHAR(4)   NULL,
            success     TINYINT(1)   NOT NULL DEFAULT 1,
            error_code  VARCHAR(64)  NULL,
            latency_ms  INT UNSIGNED NULL,
            created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_guild_created (guild_id, created_at),
            KEY idx_path_created (path, created_at),
            KEY idx_created (created_at),
            KEY idx_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.query(`
        CREATE TABLE IF NOT EXISTS command_usage_daily (
            day           DATE         NOT NULL,
            guild_id      VARCHAR(20)  NOT NULL DEFAULT '',
            path          VARCHAR(100) NOT NULL,
            kind          ENUM('slash','prefix','slash_text','context') NOT NULL,
            source        ENUM('live','backfill_audit','backfill_log','backfill_message') NOT NULL DEFAULT 'live',
            uses          INT UNSIGNED NOT NULL DEFAULT 0,
            unique_users  INT UNSIGNED NOT NULL DEFAULT 0,
            errors        INT UNSIGNED NOT NULL DEFAULT 0,
            PRIMARY KEY (day, guild_id, path, kind, source),
            KEY idx_path_day (path, day),
            KEY idx_guild_day (guild_id, day)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.query(`
        INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES
            ('command_usage', 'created_at', 400, 1, 'One row per command run. Rolled up daily into command_usage_daily (no user ids, kept forever).')`);
}

export async function down(db) {
    await db.query("DELETE FROM data_retention_policy WHERE table_name = 'command_usage'");
    await db.query('DROP TABLE IF EXISTS command_usage_daily');
    await db.query('DROP TABLE IF EXISTS command_usage');
}
