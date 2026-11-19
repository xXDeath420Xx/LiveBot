/*
 * Migration 316: persistent world memory for the AI Dungeon Master (core/rpg-world-memory.js).
 *
 * The AI DM's {{NPC}}, {{LOCATION}}, {{TIME}} and {{WEATHER}} tags only ever reached an in-memory
 * Map, so a restart or a new session forgot the world; the prompt's quest list read
 * dnd_sessions.active_quests, which nothing wrote. These existing, empty tables now hold it:
 *
 *   dnd_campaign_npcs
 *       + description   TEXT       the DM's {{NPC:name:description}} text
 *       + last_seen_at  TIMESTAMP  ordering for the prompt / journal
 *       + UNIQUE uq_campaign_npc (campaign_id, npc_name) — one row per NPC per campaign (upserts)
 *   dnd_campaign_locations
 *       + last_visited_at TIMESTAMP
 *       + UNIQUE uq_campaign_location (campaign_id, location_name)
 *   dnd_campaign_quests   — the quest log driven by the new {{QUEST:name:ACTION:detail}} tag
 *       + updated_at    TIMESTAMP ON UPDATE
 *       + UNIQUE uq_campaign_quest (campaign_id, quest_name)
 *   dnd_zone_discoveries  — per-character exploration log (/rpg journal map)
 *       + campaign_id     INT NULL   which campaign the place was found in
 *       + last_visited_at TIMESTAMP
 *       (UNIQUE (character_id, zone_id) already exists as `unique_discovery`)
 *   dnd_world_state already has UNIQUE (campaign_id, state_key); no change.
 *
 * The unique keys are added only when no duplicate rows exist (all four tables are empty today);
 * otherwise the migration stops with an explanation instead of failing half-way.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['dnd_campaign_npcs', 'description', 'TEXT NULL DEFAULT NULL AFTER occupation'],
    ['dnd_campaign_npcs', 'last_seen_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['dnd_campaign_locations', 'last_visited_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['dnd_campaign_quests', 'updated_at', 'TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP'],
    ['dnd_zone_discoveries', 'campaign_id', 'INT NULL DEFAULT NULL AFTER zone_id'],
    ['dnd_zone_discoveries', 'last_visited_at', 'TIMESTAMP NULL DEFAULT NULL'],
];

const UNIQUE_KEYS = [
    ['dnd_campaign_npcs', 'uq_campaign_npc', ['campaign_id', 'npc_name']],
    ['dnd_campaign_locations', 'uq_campaign_location', ['campaign_id', 'location_name']],
    ['dnd_campaign_quests', 'uq_campaign_quest', ['campaign_id', 'quest_name']],
];

const INDEXES = [
    ['dnd_zone_discoveries', 'idx_campaign', '(campaign_id)'],
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

    for (const [table, index, cols] of UNIQUE_KEYS) {
        if (await hasIndex(db, table, index)) continue;
        const colList = cols.map(c => `\`${c}\``).join(', ');
        const [[dup]] = await db.execute(
            `SELECT COUNT(*) AS n FROM (SELECT 1 FROM \`${table}\` GROUP BY ${colList} HAVING COUNT(*) > 1) d`);
        if (Number(dup.n) > 0) {
            throw new Error(`${table} has ${dup.n} duplicate (${cols.join(', ')}) group(s); merge them before adding ${index}`);
        }
        await db.execute(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${index}\` (${colList})`);
    }

    for (const [table, index, cols] of INDEXES) {
        if (!(await hasIndex(db, table, index))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` ${cols}`);
        }
    }
}

export async function down(db) {
    for (const [table, index] of [...INDEXES, ...UNIQUE_KEYS]) {
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
