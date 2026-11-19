/*
 * Throttle state for "I can't assign your live role" owner DMs.
 *
 * core/role-hierarchy-notifier.js DMs a server owner when Discord refuses a live-role
 * write with 50013/50001. The failure repeats on every stream-check cycle for as long
 * as the hierarchy stays wrong — two guilds were producing ~1150 of them a day — so
 * without a persisted throttle the "helpful notice" would be a DM flood.
 *
 * Keyed on (guild_id, role_id) rather than guild alone: a guild can have several live
 * roles (per-tier routing), and each one is a separate fix with a separate explanation.
 *
 * State, not just a timestamp, because an undeliverable notice is its own problem worth
 * seeing:
 *   pending    - slot claimed, send in progress
 *   sent       - the owner got it
 *   dm_blocked - owner has DMs from server members closed; nobody was told
 *   no_owner   - couldn't resolve the owner at all
 *
 * `first_failed_at` is deliberately never updated after insert — it's how long this has
 * been broken, which is the number worth knowing when triaging.
 */

export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS role_permission_notices (
            guild_id         VARCHAR(20)  NOT NULL,
            role_id          VARCHAR(20)  NOT NULL,
            first_failed_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_notified_at TIMESTAMP    NULL DEFAULT NULL,
            notice_count     INT          NOT NULL DEFAULT 0,
            last_reason      VARCHAR(16)  NULL DEFAULT NULL
                             COMMENT 'hierarchy | permission | managed',
            delivery_state   VARCHAR(16)  NOT NULL DEFAULT 'pending'
                             COMMENT 'pending | sent | dm_blocked | no_owner',
            PRIMARY KEY (guild_id, role_id),
            KEY idx_delivery_state (delivery_state)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS role_permission_notices');
}
