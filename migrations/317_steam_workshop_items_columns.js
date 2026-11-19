/*
 * Migration 317: steam_workshop_items columns for the Workshop watcher.
 *
 * `/media steam watch type:Workshop Items` has always created 'app_workshop' watchers, but
 * core/steam-watcher-manager.js rejected the type and nothing ever filled steam_workshop_items.
 * The watcher now polls IPublishedFileService/QueryFiles (newest + recently updated), caches every
 * item here and posts new/updated items to the watcher's channel (de-duplicated via
 * steam_notifications).
 *
 *   + creator_steamid    VARCHAR(20)  the author's SteamID64 (creator_name holds the resolved
 *                                     persona name; names are looked up once and reused by id)
 *   + short_description  TEXT         Steam's short description, shown in the embed
 *   + idx_creator (creator_steamid), idx_app_created (app_id, time_created)
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['steam_workshop_items', 'creator_steamid', 'VARCHAR(20) NULL DEFAULT NULL AFTER creator_name'],
    ['steam_workshop_items', 'short_description', 'TEXT NULL DEFAULT NULL AFTER title'],
];

const INDEXES = [
    ['steam_workshop_items', 'idx_creator', '(creator_steamid)'],
    ['steam_workshop_items', 'idx_app_created', '(app_id, time_created)'],
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
