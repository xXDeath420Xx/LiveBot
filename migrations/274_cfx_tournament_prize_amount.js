/*
 * Migration 274: cfx_tournament_participants.prize_amount (CFX grow game tournaments).
 *
 * When a tournament ends, services/certifried-extension/jobs/tournament-tick.js ranks the
 * participants and records each one's prize (50% / 30% / 20% of the prize pool for places
 * 1-3); routes/tournaments.js shows it on the leaderboard and pays it out on "claim".
 * The column never existed, so for any tournament with participants the completion UPDATE
 * fails ("Unknown column 'prize_amount'"), the whole completion rolls back and the tournament
 * stays 'active' (retried every tick) — nobody could ever claim a prize. This adds the column
 * the job and the claim route use.
 *
 *   prize_amount  cash prize for this participant, 0 = no prize (default for everyone
 *                 until the tournament completes)
 *
 * Idempotent: added only if information_schema says it is missing.
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'cfx_tournament_participants', 'prize_amount'))) {
        await db.execute(
            'ALTER TABLE cfx_tournament_participants ADD COLUMN prize_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00'
        );
    }
}

export async function down(db) {
    if (await hasColumn(db, 'cfx_tournament_participants', 'prize_amount')) {
        await db.execute('ALTER TABLE cfx_tournament_participants DROP COLUMN prize_amount');
    }
}
