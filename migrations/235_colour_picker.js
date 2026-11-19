/*
 * Colour picker storage.
 *
 * `colour_picker_roles` is an explicit list rather than "every coloured role
 * below position N". Position alone can't tell a pickable colour from a Birthday
 * or VIP role that also carries a colour and deliberately sits outside the block,
 * and any reorder silently changes what the menu offers.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS colour_picker_roles (
            guild_id   VARCHAR(20) NOT NULL,
            role_id    VARCHAR(20) NOT NULL,
            source     ENUM('seed','member') NOT NULL DEFAULT 'seed',
            added_by   VARCHAR(20) NULL,
            added_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, role_id),
            KEY idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Where a newly created colour should be slotted, and where the picker panel lives.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS colour_picker_config (
            guild_id      VARCHAR(20) NOT NULL PRIMARY KEY,
            role_id       VARCHAR(20) NULL,
            channel_id    VARCHAR(20) NULL,
            message_id    VARCHAR(20) NULL,
            allow_custom  TINYINT(1) NOT NULL DEFAULT 1,
            retire_days   INT NOT NULL DEFAULT 30,
            updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Last time anybody wore a colour — so retirement can spare one that is simply
    // out of fashion this month rather than genuinely dead.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS colour_role_usage (
            guild_id   VARCHAR(20) NOT NULL,
            role_id    VARCHAR(20) NOT NULL,
            last_used  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, role_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS colour_role_usage');
    await db.execute('DROP TABLE IF EXISTS colour_picker_config');
    await db.execute('DROP TABLE IF EXISTS colour_picker_roles');
}
