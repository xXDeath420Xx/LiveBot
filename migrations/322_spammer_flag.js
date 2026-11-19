/*
 * Migration 322: Discord-flagged spammers (core/spammer-guard.js).
 *
 *   join_gate_config        spammer_* settings — the fourth feature on this row. Off until a
 *                           server switches it on (kick when it does): a server that never asked
 *                           for removals gets none.
 *   spammer_flag_allowlist  members staff have cleared despite the flag (Discord's flag can be
 *                           wrong; the member appeals to Discord, staff let them stay meanwhile).
 *   join_gate_events        action enum gains the spammer outcomes.
 *
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

const OLD_EVENT_ACTIONS = ['kicked_new', 'kicked_apply', 'allowed_approved', 'allowed_pending', 'failed',
    'rejoin_banned', 'rejoin_kicked', 'rejoin_apply', 'rejoin_observed'];
const EVENT_ACTIONS = [...OLD_EVENT_ACTIONS, 'spammer_banned', 'spammer_kicked', 'spammer_flagged', 'spammer_observed'];
const enumOf = (values) => `ENUM(${values.map(v => `'${v}'`).join(',')})`;

const COLUMNS = [
    ['spammer_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['spammer_action', "VARCHAR(10) NOT NULL DEFAULT 'kick'"],
    ['spammer_role_id', 'VARCHAR(20) DEFAULT NULL'],
    ['spammer_silent', 'TINYINT(1) NOT NULL DEFAULT 0'],
];

export async function up(db) {
    for (const [name, def] of COLUMNS) {
        if (!(await hasColumn(db, 'join_gate_config', name))) {
            await db.execute(`ALTER TABLE join_gate_config ADD COLUMN ${name} ${def}`);
        }
    }
    if (!(await hasTable(db, 'spammer_flag_allowlist'))) {
        await db.execute(`
            CREATE TABLE spammer_flag_allowlist (
                guild_id  VARCHAR(20) NOT NULL,
                user_id   VARCHAR(20) NOT NULL,
                added_by  VARCHAR(20) DEFAULT NULL,
                added_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    }
    await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(EVENT_ACTIONS)} NOT NULL`);
}

export async function down(db) {
    await db.execute("DELETE FROM join_gate_events WHERE action LIKE 'spammer\\_%'");
    await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(OLD_EVENT_ACTIONS)} NOT NULL`);
    await db.execute('DROP TABLE IF EXISTS spammer_flag_allowlist');
    for (const [name] of COLUMNS) {
        if (await hasColumn(db, 'join_gate_config', name)) await db.execute(`ALTER TABLE join_gate_config DROP COLUMN ${name}`);
    }
}
