/*
 * Migration 308: bracket tournaments (/tournament) — fills in the empty tournaments,
 * tournament_participants and tournament_matches tables.
 *
 * core/tournament-manager.js runs single-elimination, double-elimination and round-robin events:
 * a sign-up window, seeding, bracket generation with byes (core/bracket.js), match reports by
 * players with opponent confirmation (or staff override), automatic advancement, a winner
 * announcement and an optional coin prize.
 *
 *   tournaments (existing: name, game, organizer_id, bracket_type, max_participants, status,
 *                prize_pool, rules, start_time, completed_at, winner_id)
 *     start_time is used as the sign-up deadline: the scheduler starts the bracket then.
 *     + channel_id, message_id    where the sign-up / bracket post lives
 *     + seeding                   'random' | 'signup' | 'manual'
 *     + prize_coins, prize_paid   optional economy prize; prize_paid guards the payout
 *     + runner_up_id              user id of second place
 *     + started_at                when the bracket was generated
 *
 *   tournament_participants
 *     + UNIQUE (tournament_id, user_id)  one sign-up per member, enforced by the database
 *
 *   tournament_matches (participant1_id / participant2_id / winner_id are tournament_participants.id;
 *                       0 marks a bye, NULL a slot still waiting on an earlier match)
 *     + bracket                     'W' winners/single, 'L' losers, 'GF' grand final, 'RR' round robin
 *     + reported_by, reported_winner_id, reported_score, reported_at
 *                                   a player's report awaiting the opponent's confirmation
 *     + confirm_deadline            the report is accepted automatically after this
 *     + report_message_id           the Confirm/Dispute post
 *     + disputed                    the opponent disputed the last report (staff decides)
 *     + decided_by                  who settled it: opponent / staff user id, or 'auto'
 *     + result_seq                  order results were recorded in; the bracket is rebuilt by
 *                                   replaying results in this order (see core/bracket.js)
 *     + UNIQUE (tournament_id, bracket, round_number, match_number)
 *
 * All three tables were empty when this was written; duplicates stop the migration with a message.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */

const TABLES = ['tournaments', 'tournament_participants', 'tournament_matches'];

const COLUMNS = [
    ['tournaments', 'channel_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['tournaments', 'message_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['tournaments', 'seeding', "VARCHAR(10) NOT NULL DEFAULT 'random'"],
    ['tournaments', 'prize_coins', 'INT NOT NULL DEFAULT 0'],
    ['tournaments', 'prize_paid', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['tournaments', 'runner_up_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['tournaments', 'started_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['tournament_matches', 'bracket', "VARCHAR(2) NOT NULL DEFAULT 'W'"],
    ['tournament_matches', 'reported_by', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['tournament_matches', 'reported_winner_id', 'BIGINT NULL DEFAULT NULL'],
    ['tournament_matches', 'reported_score', 'VARCHAR(50) NULL DEFAULT NULL'],
    ['tournament_matches', 'reported_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['tournament_matches', 'confirm_deadline', 'TIMESTAMP NULL DEFAULT NULL'],
    ['tournament_matches', 'report_message_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['tournament_matches', 'disputed', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['tournament_matches', 'decided_by', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['tournament_matches', 'result_seq', 'INT NULL DEFAULT NULL'],
];

const UNIQUES = [
    ['tournament_participants', 'uq_tournament_user', ['tournament_id', 'user_id']],
    ['tournament_matches', 'uq_tournament_slot', ['tournament_id', 'bracket', 'round_number', 'match_number']],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

async function hasUniqueOn(db, table, columns) {
    const [rows] = await db.execute(
        `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0
          GROUP BY INDEX_NAME`,
        [table]
    );
    return rows.some(r => r.cols === columns.join(','));
}

export async function up(db) {
    for (const table of TABLES) {
        const [[row]] = await db.execute(
            'SELECT TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
            [table]);
        if (!row) throw new Error(`[308] table ${table} is missing`);
        if (!String(row.c).startsWith('utf8mb4')) {
            await db.execute(`ALTER TABLE \`${table}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        }
    }

    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }

    for (const [table, name, columns] of UNIQUES) {
        if (await hasUniqueOn(db, table, columns)) continue;
        const cols = columns.map(c => `\`${c}\``).join(', ');
        const [[d]] = await db.execute(
            `SELECT COUNT(*) AS n FROM (SELECT 1 FROM \`${table}\` GROUP BY ${cols} HAVING COUNT(*) > 1) x`);
        if (Number(d.n) > 0) {
            throw new Error(`[308] ${table} has ${d.n} duplicate (${columns.join(', ')}) groups — resolve them, then re-run`);
        }
        await db.execute(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${name}\` (${cols})`);
    }
}

export async function down(db) {
    for (const [table, name] of UNIQUES) {
        await db.execute(`ALTER TABLE \`${table}\` DROP INDEX \`${name}\``).catch(() => {});
    }
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
