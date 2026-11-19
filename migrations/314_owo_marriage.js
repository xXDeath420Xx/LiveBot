/*
 * Migration 314: OwO marriage (owo_marriage, owo_propose).
 * (OwO module — CC-BY-NC-SA derivative of OwO Bot, see /LICENSE-OWO-NOTICE.md.)
 *
 * Migration 089 skipped upstream's `marriage` and `propose` tables. core/owo/marriage-service.js
 * now implements rings + marriage, so they are created here, per server and keyed by Discord ids
 * (upstream keyed them by its internal `user.uid`; owo_user was dropped, so no uid mapping):
 *
 *   owo_marriage  one row per couple; user1 < user2 numerically.
 *                   rid         ring (1-7, catalog in core/owo/social-math.js RINGS)
 *                   married_at  wedding time (the daily bonus starts the next day)
 *                   dailies     how many days the couple has claimed the bonus
 *                   claim_date  when the bonus was last paid (once per day per couple)
 *                 UNIQUE (guild_id, user1) and (guild_id, user2): a member is in at most one
 *                 marriage per server (the service also checks across both columns).
 *
 *   owo_propose   pending proposals; the proposer's ring is held until accept/decline.
 *                 PK (guild_id, sender) + UNIQUE (guild_id, receiver): one outgoing and one
 *                 incoming proposal per member.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS owo_marriage (
        guild_id     VARCHAR(20) NOT NULL,
        user1        VARCHAR(20) NOT NULL,
        user2        VARCHAR(20) NOT NULL,
        rid          TINYINT UNSIGNED NOT NULL,
        married_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        dailies      INT UNSIGNED NOT NULL DEFAULT 0,
        claim_date   TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (guild_id, user1, user2),
        UNIQUE KEY uk_owo_marriage_user1 (guild_id, user1),
        UNIQUE KEY uk_owo_marriage_user2 (guild_id, user2)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.execute(`CREATE TABLE IF NOT EXISTS owo_propose (
        guild_id     VARCHAR(20) NOT NULL,
        sender       VARCHAR(20) NOT NULL,
        receiver     VARCHAR(20) NOT NULL,
        rid          TINYINT UNSIGNED NOT NULL,
        channel_id   VARCHAR(20) NULL DEFAULT NULL,
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, sender),
        UNIQUE KEY uk_owo_propose_receiver (guild_id, receiver)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    // Only the tables this migration created.
    await db.execute('DROP TABLE IF EXISTS owo_propose');
    await db.execute('DROP TABLE IF EXISTS owo_marriage');
}
