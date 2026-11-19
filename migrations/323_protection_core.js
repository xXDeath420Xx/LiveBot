/*
 * Migration 323: one protection allowlist, bot-manager roles and the global pause
 * (core/protection-exempt.js).
 *
 *   protection_allowlist   one row per trusted thing, by kind:
 *                            user     exempt from every automated protection
 *                            role     the same for everyone holding it
 *                            held     a member recorded holding an allowlisted role (via_role_id) —
 *                                     they stay exempt after the role is taken off them
 *                            manager  a role that may configure the bot without Manage Server, and
 *                                     counts as allowlisted
 *                          Consolidates two older lists, whose rows are copied in here:
 *                            automod_user_whitelist  (utils/automod-whitelist.js now reads/writes this table)
 *                            spammer_flag_allowlist  (core/spammer-guard.js now reads/writes this table)
 *                          Both old tables are left in place, unused, so a rollback loses nothing.
 *   guilds                 protection_paused (+ until / by / at / reason): the per-server pause sits
 *                          beside the server's other guild-wide switches rather than in a table of its own.
 *
 * Nothing changes for a server until it adds something (the copied rows keep doing what they did).
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

const GUILD_COLUMNS = [
    ['protection_paused', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['protection_paused_until', 'DATETIME DEFAULT NULL'],
    ['protection_paused_by', 'VARCHAR(20) DEFAULT NULL'],
    ['protection_paused_at', 'DATETIME DEFAULT NULL'],
    ['protection_pause_reason', 'VARCHAR(200) DEFAULT NULL'],
];

export async function up(db) {
    if (!(await hasTable(db, 'protection_allowlist'))) {
        await db.execute(`
            CREATE TABLE protection_allowlist (
                guild_id     VARCHAR(20) NOT NULL,
                kind         ENUM('user','role','held','manager') NOT NULL,
                target_id    VARCHAR(20) NOT NULL,
                via_role_id  VARCHAR(20) DEFAULT NULL,
                added_by     VARCHAR(20) DEFAULT NULL,
                note         VARCHAR(255) DEFAULT NULL,
                added_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, kind, target_id),
                KEY idx_via_role (guild_id, via_role_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    }
    // Consolidate the older per-feature user lists. INSERT IGNORE: re-running copies nothing twice.
    if (await hasTable(db, 'automod_user_whitelist')) {
        await db.execute(`
            INSERT IGNORE INTO protection_allowlist (guild_id, kind, target_id, added_by, note, added_at)
            SELECT guild_id, 'user', user_id, added_by, LEFT(COALESCE(reason, 'from the automod whitelist'), 255), COALESCE(created_at, CURRENT_TIMESTAMP)
            FROM automod_user_whitelist`);
    }
    if (await hasTable(db, 'spammer_flag_allowlist')) {
        await db.execute(`
            INSERT IGNORE INTO protection_allowlist (guild_id, kind, target_id, added_by, note, added_at)
            SELECT guild_id, 'user', user_id, added_by, 'from the spammer-check allowlist', added_at
            FROM spammer_flag_allowlist`);
    }
    for (const [name, def] of GUILD_COLUMNS) {
        if (!(await hasColumn(db, 'guilds', name))) await db.execute(`ALTER TABLE guilds ADD COLUMN ${name} ${def}`);
    }
}

export async function down(db) {
    for (const [name] of GUILD_COLUMNS) {
        if (await hasColumn(db, 'guilds', name)) await db.execute(`ALTER TABLE guilds DROP COLUMN ${name}`);
    }
    await db.execute('DROP TABLE IF EXISTS protection_allowlist');
}
