/**
 * Migration 098: Multi-creator temp-VC support with optional role gate
 *
 * Allows a guild to configure more than one "join-to-create" voice channel,
 * each pointing at its own parent category, with an optional role
 * requirement. The role requirement is what enables, e.g., a "live-streamers
 * only" creator channel that spawns a temp VC only when the joining member
 * holds the configured Live Streamer role.
 *
 * Schema changes on temp_channel_config:
 *   - PRIMARY KEY: (guild_id) -> (guild_id, creator_channel_id)
 *   - ADD COLUMN required_role_id  VARCHAR(20) NULL
 *   - ADD COLUMN default_user_limit TINYINT UNSIGNED NULL
 *
 * Idempotent: existing rows survive (composite PK still uniquely identifies them).
 */

async function tableExists(db, table) {
    const allowed = new Set(['temp_channel_config']);
    if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
    );
    return rows[0].n > 0;
}

async function hasColumn(db, table, column) {
    const allowedTables = new Set(['temp_channel_config']);
    const allowedColumns = new Set(['required_role_id', 'default_user_limit', 'creator_channel_id']);
    if (!allowedTables.has(table) || !allowedColumns.has(column)) {
        throw new Error(`Refusing to inspect unknown table/column: ${table}/${column}`);
    }
    const [cols] = await db.execute(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
    return cols.length > 0;
}

async function pkColumns(db, table) {
    const allowed = new Set(['temp_channel_config']);
    if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    const [rows] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.STATISTICS
         WHERE table_schema = DATABASE() AND table_name = '${table}' AND index_name = 'PRIMARY'
         ORDER BY SEQ_IN_INDEX`
    );
    return rows.map(r => r.COLUMN_NAME);
}

export async function up(db) {
    if (!(await tableExists(db, 'temp_channel_config'))) {
        await db.execute(`
            CREATE TABLE temp_channel_config (
                guild_id            VARCHAR(20)        NOT NULL,
                creator_channel_id  VARCHAR(20)        NOT NULL,
                category_id         VARCHAR(20)        NOT NULL,
                naming_template     VARCHAR(100)       DEFAULT '{user}''s Channel',
                required_role_id    VARCHAR(20)        NULL,
                default_user_limit  TINYINT UNSIGNED   NULL,
                created_at          TIMESTAMP          DEFAULT CURRENT_TIMESTAMP,
                updated_at          TIMESTAMP          DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, creator_channel_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('[Migration 098] Created temp_channel_config with composite PK');
        return;
    }

    if (!(await hasColumn(db, 'temp_channel_config', 'required_role_id'))) {
        await db.execute(`
            ALTER TABLE temp_channel_config
            ADD COLUMN required_role_id VARCHAR(20) NULL
            COMMENT 'When set, only members with this role can spawn a temp VC from this creator'
        `);
    }

    if (!(await hasColumn(db, 'temp_channel_config', 'default_user_limit'))) {
        await db.execute(`
            ALTER TABLE temp_channel_config
            ADD COLUMN default_user_limit TINYINT UNSIGNED NULL
            COMMENT 'Optional preset user limit applied to spawned channels (0/null = no limit)'
        `);
    }

    const pk = await pkColumns(db, 'temp_channel_config');
    const isCompositePk = pk.length === 2 && pk[0] === 'guild_id' && pk[1] === 'creator_channel_id';
    if (!isCompositePk) {
        await db.execute(`ALTER TABLE temp_channel_config DROP PRIMARY KEY, ADD PRIMARY KEY (guild_id, creator_channel_id)`);
        console.log('[Migration 098] Switched temp_channel_config primary key to (guild_id, creator_channel_id)');
    }

    console.log('[Migration 098] temp_channel_config now supports multi-creator + role gate');
}

export async function down(db) {
    const pk = await pkColumns(db, 'temp_channel_config');
    const isCompositePk = pk.length === 2 && pk[0] === 'guild_id' && pk[1] === 'creator_channel_id';
    if (isCompositePk) {
        await db.execute(`ALTER TABLE temp_channel_config DROP PRIMARY KEY, ADD PRIMARY KEY (guild_id)`);
    }
    if (await hasColumn(db, 'temp_channel_config', 'required_role_id')) {
        await db.execute(`ALTER TABLE temp_channel_config DROP COLUMN required_role_id`);
    }
    if (await hasColumn(db, 'temp_channel_config', 'default_user_limit')) {
        await db.execute(`ALTER TABLE temp_channel_config DROP COLUMN default_user_limit`);
    }
    console.log('[Migration 098] Rolled back - reverted temp_channel_config to single-PK schema');
}
