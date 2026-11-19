/*
 * Migration 279: separate "win trivia" from "play trivia" daily challenges.
 *
 * "Trivia Novice — Play 3 trivia games" and "Trivia Expert — Win 5 trivia games" both had
 * challenge_type 'trivia', so a single progress counter could not tell playing from winning.
 * Trivia now reports 'trivia' for every game played and 'trivia_win' for a win; this moves the
 * win challenge onto the new type. Progress was never reported before, so no stored progress changes meaning.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
    await db.execute(
        `UPDATE daily_challenges SET challenge_type = 'trivia_win'
          WHERE challenge_type = 'trivia' AND challenge_name = 'Trivia Expert'`
    );
}

export async function down(db) {
    await db.execute(
        `UPDATE daily_challenges SET challenge_type = 'trivia'
          WHERE challenge_type = 'trivia_win' AND challenge_name = 'Trivia Expert'`
    );
}
