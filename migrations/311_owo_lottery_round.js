/*
 * Migration 311: OwO lottery rounds (owo_lottery_round).
 * (OwO module — CC-BY-NC-SA derivative of OwO Bot, see /LICENSE-OWO-NOTICE.md.)
 *
 * owo_lottery (existing, empty) holds each member's entry for the current round. Upstream drew its
 * lottery from a script outside the bot and kept no per-round state; per server we need to know
 * when the next draw is due so a restart can catch up on it, where to announce it, and what the
 * last result was. One row per server:
 *
 *   draw_at            next draw (local midnight, same boundary as every OwO daily). Explicit
 *                      DEFAULT so MariaDB does not add ON UPDATE CURRENT_TIMESTAMP to it.
 *   round_no           increments per paid-out draw
 *   announce_channel   channel of the latest entry; the result is posted there
 *   last_winner, last_pot, last_participants, last_drawn_at   previous result, for `owo lottery`
 *
 * jobs/owo-lottery-draw.js runs due rows every minute; core/owo/lottery-service.js drawRound() moves
 * draw_at forward in the same transaction that pays the winner.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS owo_lottery_round (
        guild_id           VARCHAR(20) NOT NULL,
        draw_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        round_no           INT UNSIGNED NOT NULL DEFAULT 1,
        announce_channel   VARCHAR(20) NULL DEFAULT NULL,
        last_winner        VARCHAR(20) NULL DEFAULT NULL,
        last_pot           BIGINT UNSIGNED NOT NULL DEFAULT 0,
        last_participants  INT UNSIGNED NOT NULL DEFAULT 0,
        last_drawn_at      TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (guild_id),
        KEY idx_owo_lottery_round_due (draw_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    // Only the table this migration created.
    await db.execute('DROP TABLE IF EXISTS owo_lottery_round');
}
