/**
 * Migration 088: Expand owo_config with per-guild tuning knobs.
 *
 * Adds: hunt cooldown, reward/sell/sacrifice multipliers, disabled
 * subcommands, channel allow-list, role block-list, rare-catch announce
 * flag. All additive + nullable/defaulted so existing rows keep working.
 *
 * Idempotent: each column guarded by SHOW COLUMNS so re-runs are safe
 * (pattern from migration 086).
 */

const COLUMNS = [
    { name: 'hunt_cooldown_seconds',       ddl: 'INT UNSIGNED NOT NULL DEFAULT 15' },
    { name: 'reward_currency_multiplier',  ddl: 'DECIMAL(5,2) NOT NULL DEFAULT 1.00' },
    { name: 'reward_xp_multiplier',        ddl: 'DECIMAL(5,2) NOT NULL DEFAULT 1.00' },
    { name: 'sell_multiplier',             ddl: 'DECIMAL(5,2) NOT NULL DEFAULT 0.50' },
    { name: 'sacrifice_xp_multiplier',     ddl: 'DECIMAL(5,2) NOT NULL DEFAULT 1.00' },
    { name: 'disabled_subcommands',        ddl: "LONGTEXT NULL COMMENT 'JSON array of subcommand names'" },
    { name: 'allowed_channel_ids',         ddl: "LONGTEXT NULL COMMENT 'JSON array; NULL/[] = all channels'" },
    { name: 'blocked_role_ids',            ddl: "LONGTEXT NULL COMMENT 'JSON array; members with these roles cannot use OwO'" },
    { name: 'announce_rare_catches',       ddl: 'TINYINT(1) NOT NULL DEFAULT 1' },
];

async function existingColumns(db) {
    const [rows] = await db.execute('SHOW COLUMNS FROM owo_config');
    return new Set(rows.map(r => r.Field));
}

export async function up(db) {
    const existing = await existingColumns(db);
    for (const col of COLUMNS) {
        if (!existing.has(col.name)) {
            await db.execute(`ALTER TABLE owo_config ADD COLUMN ${col.name} ${col.ddl}`);
        }
    }
}

export async function down(db) {
    const existing = await existingColumns(db);
    for (const col of COLUMNS) {
        if (existing.has(col.name)) {
            await db.execute(`ALTER TABLE owo_config DROP COLUMN ${col.name}`);
        }
    }
}
