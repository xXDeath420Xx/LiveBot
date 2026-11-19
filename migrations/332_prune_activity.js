/*
 * Migration 332: inactivity prune + per-member activity (core/inactivity-prune.js, core/member-activity.js;
 * rules in core/inactivity-prune-logic.js).
 *
 *   member_activity      NEW. One row per member per server: first activity, last message, last voice-channel
 *                        join, and when the inactivity prune warned / logged them. Nothing the bot kept could
 *                        answer "when was this member last here" a year back (activity_logs is purged after
 *                        180 days and writes voice only when a session ends; message_stats / voice_activity are
 *                        per-channel-per-day and per-finished-session analytics; user_levels moves only on XP
 *                        awards). Backfilled here from message_stats, voice_activity and activity_logs (days
 *                        count to the END of the day: the generous reading), so their history is not lost.
 *   guilds               activity_tracked_since: when tracking began for the server. Back-dated to the start of
 *                        the history the backfill could read for it — the LATER of its oldest message and its
 *                        oldest voice record (a server whose voice log starts later must not judge voice-only
 *                        members on months with no voice log), or now when there is no message history at all.
 *                        Servers added later get it set to now the first time it is needed. Nobody is ever judged
 *                        on time before it (the fairness rule).
 *   join_gate_config     inactive_* settings beside auto-prune's prune_*: both rules OFF for every server.
 *   join_gate_events     action enum gains prune_inactive_kicked / _warned / _logged / _held.
 *
 * Writes: the backfill (INSERT ... SELECT, idempotent: re-running keeps the later times) and the
 * tracking-start dates (only where still NULL). No existing row is changed otherwise.
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

/** The values of an ENUM column, in order ('' when the column is missing). */
async function enumValues(db, table, column) {
    const [rows] = await db.execute(
        'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    const type = String(rows[0]?.t ?? '');
    return [...type.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
}

export const enumOf = (values) => `ENUM(${values.map(v => `'${v}'`).join(',')})`;
export const mergeEnum = (current, add) => [...current, ...add.filter(v => !current.includes(v))];

export const ACTIVITY_TABLE = `CREATE TABLE IF NOT EXISTS member_activity (
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    first_active_at DATETIME NULL,
    last_message_at DATETIME NULL,
    last_voice_at DATETIME NULL,
    inactivity_warned_at DATETIME NULL,
    inactivity_logged_at DATETIME NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`;

export const INACTIVE_COLUMNS = [
    ['inactive_never_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['inactive_never_days', 'INT NOT NULL DEFAULT 30'],
    ['inactive_never_action', "VARCHAR(10) NOT NULL DEFAULT 'log'"],
    ['inactive_quiet_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['inactive_quiet_days', 'INT NOT NULL DEFAULT 90'],
    ['inactive_quiet_action', "VARCHAR(10) NOT NULL DEFAULT 'log'"],
    ['inactive_exempt_roles', 'TEXT NULL'],
    ['inactive_exempt_boosters', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['inactive_exempt_staff', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['inactive_min_member_days', 'INT NOT NULL DEFAULT 7'],
    ['inactive_warn_days', 'INT NOT NULL DEFAULT 3'],
    ['inactive_max_per_sweep', 'INT NOT NULL DEFAULT 25'],
    ['inactive_daily_cap', 'INT NOT NULL DEFAULT 100'],
    ['inactive_last_sweep_at', 'DATETIME NULL'],
    ['inactive_last_result', 'TEXT NULL'],
];

export const GUILD_COLUMN = ['activity_tracked_since', 'DATETIME NULL'];

export const EVENT_ACTIONS_ADDED = ['prune_inactive_kicked', 'prune_inactive_warned', 'prune_inactive_logged', 'prune_inactive_held'];

const ID_OK = (col) => `${col} IS NOT NULL AND CHAR_LENGTH(${col}) BETWEEN 15 AND 20`;
const KEEP_LATER = (col) => `${col} = IF(VALUES(${col}) IS NULL, ${col}, GREATEST(COALESCE(${col}, VALUES(${col})), VALUES(${col})))`;
const KEEP_EARLIER = (col) => `${col} = IF(VALUES(${col}) IS NULL, ${col}, LEAST(COALESCE(${col}, VALUES(${col})), VALUES(${col})))`;
const UPSERT_TAIL = `ON DUPLICATE KEY UPDATE ${KEEP_EARLIER('first_active_at')}, ${KEEP_LATER('last_message_at')}, ${KEEP_LATER('last_voice_at')}`;
/** A DATE as the last second of that day, never later than now. */
const END_OF = (expr) => `LEAST(NOW(), DATE_ADD(${expr}, INTERVAL 86399 SECOND))`;

/** The SELECT half of each backfill statement (exported so the tests can check them; they only run through up()). */
export const BACKFILL_SELECTS = [
    // Messages: one row per channel per day per member.
    `SELECT guild_id, user_id, MIN(stat_date) AS f, ${END_OF('MAX(stat_date)')} AS lm, NULL AS lv
       FROM message_stats WHERE ${ID_OK('guild_id')} AND ${ID_OK('user_id')}
      GROUP BY guild_id, user_id`,
    // Voice sessions (written when a session ends; joined_at is the join).
    `SELECT guild_id, user_id, MIN(joined_at) AS f, NULL AS lm, MAX(joined_at) AS lv
       FROM voice_activity WHERE ${ID_OK('guild_id')} AND ${ID_OK('user_id')} AND joined_at IS NOT NULL
      GROUP BY guild_id, user_id`,
    // The 180-day daily counters (messages and voice), which also cover messages message_stats missed.
    `SELECT guild_id, user_id, MIN(log_date) AS f,
            ${END_OF("MAX(CASE WHEN type = 'message' THEN log_date END)")} AS lm,
            ${END_OF("MAX(CASE WHEN type = 'voice' THEN log_date END)")} AS lv
       FROM activity_logs WHERE ${ID_OK('guild_id')} AND ${ID_OK('user_id')}
      GROUP BY guild_id, user_id`,
];
export const BACKFILL_SOURCES = ['message_stats', 'voice_activity', 'activity_logs'];

/** The grouped SELECT goes in a derived table: no GROUP BY / ON DUPLICATE KEY ambiguity. */
export const backfillSql = (select) => `INSERT INTO member_activity (guild_id, user_id, first_active_at, last_message_at, last_voice_at)
     SELECT x.guild_id, x.user_id, x.f, x.lm, x.lv FROM (${select}) AS x
     ${UPSERT_TAIL}`;

/**
 * Per server: the later of its oldest message record and its oldest voice record (the global voice log
 * start when it has none — it simply never used voice), or now with no message history at all.
 */
export const TRACKING_SINCE_SQL = `UPDATE guilds g
    LEFT JOIN (SELECT guild_id, MIN(stat_date) AS m FROM message_stats GROUP BY guild_id) ms
           ON ms.guild_id COLLATE utf8mb4_unicode_ci = g.guild_id COLLATE utf8mb4_unicode_ci
    LEFT JOIN (SELECT guild_id, MIN(joined_at) AS v FROM voice_activity WHERE guild_id IS NOT NULL GROUP BY guild_id) va
           ON va.guild_id COLLATE utf8mb4_unicode_ci = g.guild_id COLLATE utf8mb4_unicode_ci
    CROSS JOIN (SELECT MIN(joined_at) AS v FROM voice_activity) vall
      SET g.activity_tracked_since = CASE
            WHEN ms.m IS NULL THEN NOW()
            ELSE LEAST(NOW(), GREATEST(CAST(ms.m AS DATETIME), COALESCE(va.v, vall.v, CAST(ms.m AS DATETIME))))
          END
    WHERE g.activity_tracked_since IS NULL`;

export async function up(db) {
    await db.execute(ACTIVITY_TABLE);

    for (const [name, def] of INACTIVE_COLUMNS) {
        if (!(await hasColumn(db, 'join_gate_config', name))) {
            await db.execute(`ALTER TABLE join_gate_config ADD COLUMN ${name} ${def}`);
        }
    }

    if (!(await hasColumn(db, 'guilds', GUILD_COLUMN[0]))) {
        await db.execute(`ALTER TABLE guilds ADD COLUMN ${GUILD_COLUMN[0]} ${GUILD_COLUMN[1]}`);
    }

    const actions = await enumValues(db, 'join_gate_events', 'action');
    if (actions.length && EVENT_ACTIONS_ADDED.some(a => !actions.includes(a))) {
        await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(mergeEnum(actions, EVENT_ACTIONS_ADDED))} NOT NULL`);
    }

    for (let i = 0; i < BACKFILL_SELECTS.length; i++) {
        if (await hasTable(db, BACKFILL_SOURCES[i])) await db.execute(backfillSql(BACKFILL_SELECTS[i]));
    }
    if ((await hasTable(db, 'message_stats')) && (await hasTable(db, 'voice_activity'))) {
        await db.execute(TRACKING_SINCE_SQL);
    } else {
        await db.execute('UPDATE guilds SET activity_tracked_since = NOW() WHERE activity_tracked_since IS NULL');
    }
}

export async function down(db) {
    await db.execute("DELETE FROM join_gate_events WHERE action LIKE 'prune\\_inactive\\_%'");
    const actions = await enumValues(db, 'join_gate_events', 'action');
    if (actions.length) {
        await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(actions.filter(a => !EVENT_ACTIONS_ADDED.includes(a)))} NOT NULL`);
    }
    for (const [name] of INACTIVE_COLUMNS) {
        if (await hasColumn(db, 'join_gate_config', name)) await db.execute(`ALTER TABLE join_gate_config DROP COLUMN ${name}`);
    }
    if (await hasColumn(db, 'guilds', GUILD_COLUMN[0])) await db.execute(`ALTER TABLE guilds DROP COLUMN ${GUILD_COLUMN[0]}`);
    await db.execute('DROP TABLE IF EXISTS member_activity');
}

export default { up, down };
