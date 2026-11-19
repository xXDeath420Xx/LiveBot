/*
 * Ban requests.
 *
 * Her rule: a mod can stop trouble immediately but cannot ban. `/ban` from a mod
 * kicks the member — which ends the incident — and files a request for an admin
 * to turn into a ban or throw out. A kick is reversible; a ban is the thing that
 * needs the second pair of eyes.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS ban_requests (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            guild_id       VARCHAR(20)  NOT NULL,
            target_id      VARCHAR(20)  NOT NULL,
            target_tag     VARCHAR(100) NULL,
            requested_by   VARCHAR(20)  NOT NULL,
            reason         TEXT         NOT NULL,
            kicked         TINYINT(1)   NOT NULL DEFAULT 0,
            status         ENUM('pending','approved','denied','expired') NOT NULL DEFAULT 'pending',
            decided_by     VARCHAR(20)  NULL,
            decided_at     TIMESTAMP    NULL,
            decision_note  TEXT         NULL,
            channel_id     VARCHAR(20)  NULL,
            message_id     VARCHAR(20)  NULL,
            created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_guild_status (guild_id, status),
            KEY idx_target (guild_id, target_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS ban_request_config (
            guild_id       VARCHAR(20) NOT NULL PRIMARY KEY,
            request_channel_id VARCHAR(20) NULL,
            approver_role_ids  TEXT NULL,
            requester_role_ids TEXT NULL,
            updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}
export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS ban_requests');
    await db.execute('DROP TABLE IF EXISTS ban_request_config');
}
