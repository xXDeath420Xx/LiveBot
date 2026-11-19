/*
 * Migration 324: name filters (core/name-filters.js, rules in core/name-filter-logic.js).
 *
 *   automod_patterns     already holds each server's own match patterns (the message patterns of
 *                        `/protection spam pattern-*`), with hit counters in spam_patterns_stats.
 *                        Name filters are the same thing aimed at member names, so they are rows here:
 *                          target        'message' (every existing row) | 'name'
 *                          case_sensitive
 *                          origin        'manual' | 'template' (a curated pack, core/name-filter-templates.js)
 *                                        | 'auto' (Auto-Pilot: a protected staff member's name)
 *                          source_key    which pack entry / which staff name a non-manual row came from
 *                          auto_user_id  the staff member an Auto-Pilot row protects (never matched against them)
 *                          removed_at    a template or Auto-Pilot row staff deleted: kept so it is not recreated
 *                        and action gains 'log', 'flag' and 'timeout'.
 *   join_gate_config     name_* settings — the fifth feature on the join-protection row. Everything
 *                        off until a server switches it on; new actions default to log-only.
 *   join_gate_events     action enum gains the name-filter outcomes (the "recent hits" list).
 *   name_filter_reviews  the cleanse review queue, one row per member, and the "mark safe" record
 *                        (status 'safe' with the hash of the names it was given for).
 *
 * Nothing changes for a server until it adds a filter and switches name checks on.
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]);
    return rows.length > 0;
}

const enumOf = (values) => `ENUM(${values.map(v => `'${v}'`).join(',')})`;

const OLD_PATTERN_ACTIONS = ['delete', 'warn', 'mute', 'kick', 'ban'];
const PATTERN_ACTIONS = [...OLD_PATTERN_ACTIONS, 'log', 'flag', 'timeout'];

const PATTERN_COLUMNS = [
    ['target', "ENUM('message','name') NOT NULL DEFAULT 'message'"],
    ['case_sensitive', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['origin', "ENUM('manual','template','auto') NOT NULL DEFAULT 'manual'"],
    ['source_key', 'VARCHAR(100) DEFAULT NULL'],
    ['auto_user_id', 'VARCHAR(20) DEFAULT NULL'],
    ['removed_at', 'DATETIME DEFAULT NULL'],
];

const OLD_EVENT_ACTIONS = ['kicked_new', 'kicked_apply', 'allowed_approved', 'allowed_pending', 'failed',
    'rejoin_banned', 'rejoin_kicked', 'rejoin_apply', 'rejoin_observed',
    'spammer_banned', 'spammer_kicked', 'spammer_flagged', 'spammer_observed'];
const EVENT_ACTIONS = [...OLD_EVENT_ACTIONS, 'name_banned', 'name_kicked', 'name_timeout', 'name_flagged', 'name_logged'];

const CONFIG_COLUMNS = [
    ['name_filters_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],     // check names on join and on every change
    ['name_fuzzy', 'TINYINT(1) NOT NULL DEFAULT 1'],               // lookalikes / zalgo / leetspeak folding
    ['name_collapse', 'TINYINT(1) NOT NULL DEFAULT 0'],            // also ignore separators and repeated letters
    ['name_flag_role_id', 'VARCHAR(20) DEFAULT NULL'],
    ['name_timeout_minutes', 'INT NOT NULL DEFAULT 60'],
    ['name_dm', 'TINYINT(1) NOT NULL DEFAULT 1'],                  // tell kicked / banned / timed-out members why
    ['name_generated_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['name_generated_action', "VARCHAR(10) NOT NULL DEFAULT 'log'"],
    ['name_autopilot_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['name_autopilot_action', "VARCHAR(10) NOT NULL DEFAULT 'log'"],
    ['name_autopilot_managers', 'TINYINT(1) NOT NULL DEFAULT 1'],  // protect manager-role holders + allowlisted members
    ['name_autopilot_roles', 'TEXT DEFAULT NULL'],                 // JSON array of further staff role ids
    ['name_templates', 'TEXT DEFAULT NULL'],                       // JSON { packId: { action, version, server } }
];

export async function up(db) {
    for (const [name, def] of PATTERN_COLUMNS) {
        if (!(await hasColumn(db, 'automod_patterns', name))) {
            await db.execute(`ALTER TABLE automod_patterns ADD COLUMN ${name} ${def}`);
        }
    }
    await db.execute(`ALTER TABLE automod_patterns MODIFY action ${enumOf(PATTERN_ACTIONS)} DEFAULT 'delete'`);
    if (!(await hasIndex(db, 'automod_patterns', 'idx_guild_target'))) {
        await db.execute('ALTER TABLE automod_patterns ADD INDEX idx_guild_target (guild_id, target, enabled)');
    }
    if (!(await hasIndex(db, 'automod_patterns', 'uniq_guild_source'))) {
        await db.execute('ALTER TABLE automod_patterns ADD UNIQUE KEY uniq_guild_source (guild_id, source_key)');
    }

    for (const [name, def] of CONFIG_COLUMNS) {
        if (!(await hasColumn(db, 'join_gate_config', name))) {
            await db.execute(`ALTER TABLE join_gate_config ADD COLUMN ${name} ${def}`);
        }
    }
    await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(EVENT_ACTIONS)} NOT NULL`);

    if (!(await hasTable(db, 'name_filter_reviews'))) {
        await db.execute(`
            CREATE TABLE name_filter_reviews (
                guild_id      VARCHAR(20)  NOT NULL,
                user_id       VARCHAR(20)  NOT NULL,
                username      VARCHAR(100) DEFAULT NULL,
                display_name  VARCHAR(100) DEFAULT NULL,
                nickname      VARCHAR(100) DEFAULT NULL,
                filter_id     INT          DEFAULT NULL,
                filter_label  VARCHAR(200) DEFAULT NULL,
                field         VARCHAR(12)  DEFAULT NULL,
                names_hash    CHAR(16)     DEFAULT NULL,
                status        ENUM('pending','banned','kicked','safe','skipped','gone','failed') NOT NULL DEFAULT 'pending',
                detail        VARCHAR(255) DEFAULT NULL,
                found_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                decided_by    VARCHAR(20)  DEFAULT NULL,
                decided_at    DATETIME     DEFAULT NULL,
                PRIMARY KEY (guild_id, user_id),
                KEY idx_guild_status (guild_id, status, found_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    }
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS name_filter_reviews');
    await db.execute("DELETE FROM join_gate_events WHERE action LIKE 'name\\_%'");
    await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(OLD_EVENT_ACTIONS)} NOT NULL`);
    for (const [name] of CONFIG_COLUMNS) {
        if (await hasColumn(db, 'join_gate_config', name)) await db.execute(`ALTER TABLE join_gate_config DROP COLUMN ${name}`);
    }
    if (await hasColumn(db, 'automod_patterns', 'target')) {
        await db.execute("DELETE FROM automod_patterns WHERE target = 'name'");
    }
    await db.execute("UPDATE automod_patterns SET action = 'delete' WHERE action IN ('log','flag','timeout')");
    await db.execute(`ALTER TABLE automod_patterns MODIFY action ${enumOf(OLD_PATTERN_ACTIONS)} DEFAULT 'delete'`);
    if (await hasIndex(db, 'automod_patterns', 'uniq_guild_source')) await db.execute('ALTER TABLE automod_patterns DROP INDEX uniq_guild_source');
    if (await hasIndex(db, 'automod_patterns', 'idx_guild_target')) await db.execute('ALTER TABLE automod_patterns DROP INDEX idx_guild_target');
    for (const [name] of PATTERN_COLUMNS) {
        if (await hasColumn(db, 'automod_patterns', name)) await db.execute(`ALTER TABLE automod_patterns DROP COLUMN ${name}`);
    }
}
