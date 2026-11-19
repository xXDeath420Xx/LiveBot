/*
 * Migration 315: conversation memory and channel personas for the @mention AI assistant
 * (core/ai-assistant.js, /ai memory | forget | persona).
 *
 * Reuses the two empty tables that were created for this long ago and never written:
 *
 *   chatgpt_memory   one row per stored message (role 'user' | 'model').
 *       + guild_id   VARCHAR(20)  so a server's memory can be cleared (/ai disable, /ai forget,
 *                                 memory mode 'off') and expired by its own TTL
 *       + scope      ENUM('user','channel') the memory mode the row was written under. Reads only
 *                                 match the current mode, so switching a server from per-member to
 *                                 shared memory never exposes anyone's earlier private exchanges.
 *       + idx_scope_lookup (guild_id, channel_id, scope, user_id, id) for the per-mention read
 *   chatgpt_persona  one admin-set persona per channel.
 *       + guild_id, set_by
 *
 *   ai_config (per guild)
 *       + memory_mode         ENUM('off','user','channel') DEFAULT 'user' — private per-member memory.
 *                              The assistant itself stays opt-in (enabled = 0 by default).
 *       + memory_turns        exchanges remembered (1-20, default 6)
 *       + memory_ttl_minutes  forget after this many minutes (5-1440, default 60)
 *
 * Retention: core/ai-assistant.js prunes each guild past its TTL on every use and everything older
 * than 24h every 10 minutes; a data_retention_policy row (1 day, `timestamp`) is requested from
 * the lead as a backstop.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['chatgpt_memory', 'guild_id', 'VARCHAR(20) NULL DEFAULT NULL AFTER id'],
    ['chatgpt_memory', 'scope', "ENUM('user','channel') NOT NULL DEFAULT 'user' AFTER channel_id"],
    ['chatgpt_persona', 'guild_id', 'VARCHAR(20) NULL DEFAULT NULL AFTER channel_id'],
    ['chatgpt_persona', 'set_by', 'VARCHAR(20) NULL DEFAULT NULL AFTER persona'],
    ['ai_config', 'memory_mode', "ENUM('off','user','channel') NOT NULL DEFAULT 'user'"],
    ['ai_config', 'memory_turns', 'INT NOT NULL DEFAULT 6'],
    ['ai_config', 'memory_ttl_minutes', 'INT NOT NULL DEFAULT 60'],
];

const INDEXES = [
    ['chatgpt_memory', 'idx_scope_lookup', '(guild_id, channel_id, scope, user_id, id)'],
    ['chatgpt_memory', 'idx_guild_time', '(guild_id, `timestamp`)'],
    ['chatgpt_persona', 'idx_guild', '(guild_id)'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }
    for (const [table, index, cols] of INDEXES) {
        if (!(await hasIndex(db, table, index))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` ${cols}`);
        }
    }
}

export async function down(db) {
    for (const [table, index] of INDEXES) {
        if (await hasIndex(db, table, index)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
        }
    }
    for (const [table, column] of [...COLUMNS].reverse()) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
