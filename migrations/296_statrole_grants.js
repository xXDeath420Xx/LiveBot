/*
 * Migration 296: stat roles are evaluated at runtime.
 *
 * statrole_configs (guild_id, role_id, stat_type, required_amount; UNIQUE guild+role+stat) has
 * been saved by the dashboard's Stat Roles page but nothing ever read it. core/statrole-manager.js
 * now grants the role when a member reaches the requirement (messages, voice minutes, level,
 * invites, account age, days in server) — on activity and in a 15-minute sweep.
 *
 *   statrole_configs.remove_below   per rule, default 0. When 1, the role is taken back if the member
 *                                   no longer meets ANY rule for that role (e.g. the requirement was
 *                                   raised, or old activity aged out of the stats). Off by default:
 *                                   silently removing roles is the surprising behaviour.
 *   statrole_configs.created_at
 *
 *   statrole_grants (new)           which roles the bot itself granted, to whom, and why. Removal only
 *                                   ever touches a role recorded here, so a role an admin handed out
 *                                   by hand is never taken away by a stat rule.
 *
 * Apply directly: import { up } and call up(pool).
 */
const COLUMNS = [
    ['statrole_configs', 'remove_below', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['statrole_configs', 'created_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS statrole_grants (
            guild_id    VARCHAR(20)  NOT NULL,
            user_id     VARCHAR(20)  NOT NULL,
            role_id     VARCHAR(20)  NOT NULL,
            stat_type   VARCHAR(50)  NOT NULL,
            stat_value  BIGINT       NOT NULL DEFAULT 0,
            granted_at  TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, user_id, role_id),
            KEY idx_guild_role (guild_id, role_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS statrole_grants');
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
