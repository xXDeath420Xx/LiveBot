/*
 * Audit trail for bulk actions taken from an activity audit.
 *
 * Kicks are irreversible and mass ones are indistinguishable from a compromised account
 * unless there is a record of who asked, what filter selected the targets, and which
 * members were actually touched. Every planned action is written here BEFORE execution and
 * updated after, so a run that dies halfway still leaves evidence of what it had done.
 *
 * `filter_json` stores the exact filter, not a human summary: "the never-active ones" is
 * not enough to reconstruct a decision months later, and the same words can select a
 * different set once the underlying audit changes.
 *
 * Per-target rows rather than a count, because "kicked 46 members" is not an answer to
 * "was my friend one of them".
 */

export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS activity_audit_actions (
            action_id     INT AUTO_INCREMENT PRIMARY KEY,
            audit_id      INT          NOT NULL,
            guild_id      VARCHAR(20)  NOT NULL,
            action_type   VARCHAR(24)  NOT NULL COMMENT 'kick | add_role | remove_role',
            role_id       VARCHAR(20)  NULL DEFAULT NULL,
            filter_json   LONGTEXT     NULL DEFAULT NULL,
            filter_label  VARCHAR(500) NULL DEFAULT NULL,
            reason        VARCHAR(400) NULL DEFAULT NULL,
            requested_by  VARCHAR(20)  NOT NULL,
            source        VARCHAR(16)  NOT NULL DEFAULT 'dashboard',
            status        VARCHAR(16)  NOT NULL DEFAULT 'planned'
                          COMMENT 'planned | running | complete | failed | aborted',
            planned_count INT          NOT NULL DEFAULT 0,
            success_count INT          NOT NULL DEFAULT 0,
            failed_count  INT          NOT NULL DEFAULT 0,
            skipped_count INT          NOT NULL DEFAULT 0,
            created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at  TIMESTAMP    NULL DEFAULT NULL,
            error_text    TEXT         NULL DEFAULT NULL,
            KEY idx_guild_created (guild_id, created_at),
            KEY idx_audit (audit_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS activity_audit_action_targets (
            action_id    INT          NOT NULL,
            user_id      VARCHAR(20)  NOT NULL,
            display_name VARCHAR(64)  NULL DEFAULT NULL,
            outcome      VARCHAR(16)  NOT NULL DEFAULT 'pending'
                         COMMENT 'pending | done | failed | skipped',
            detail       VARCHAR(300) NULL DEFAULT NULL
                         COMMENT 'why it was skipped, or the API error',
            acted_at     TIMESTAMP    NULL DEFAULT NULL,
            PRIMARY KEY (action_id, user_id),
            KEY idx_outcome (action_id, outcome)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS activity_audit_action_targets');
    await db.execute('DROP TABLE IF EXISTS activity_audit_actions');
}
