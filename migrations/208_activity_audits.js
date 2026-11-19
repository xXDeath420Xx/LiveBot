/*
 * Stored activity-audit snapshots.
 *
 * These audits were being produced by one-off scripts, and each run threw its data away.
 * That cost real accuracy: the 2 Aug run preserved only display names, so when the 21 Aug
 * run compared against it a member who had simply renamed appeared as one departure plus
 * one arrival, and the only reason it was caught was that the earlier window happened to be
 * a complete census. Snapshots are keyed on user_id here so every future comparison is
 * identity-based and a rename is just a rename.
 *
 * Two tables rather than one JSON blob because the dashboard filters and sorts across
 * members — "everyone dormant 30+ days", "voice-only", "posted once and never spoke" are
 * all queries, and a blob would force every one of them through a full deserialise.
 *
 * Raw metrics are stored; SEGMENTS ARE NOT. Which bucket a member falls into is a policy
 * decision that will be tuned (is the dormancy line 30 days or 45?), and baking today's
 * answer into the row would make old snapshots un-recomputable. core/activity-audit.js
 * derives segments on read instead.
 *
 * `voice_seconds` is nullable-by-absence rather than zero-by-default in meaning: a guild
 * whose bot never logged voice is not the same as a guild where nobody spoke. That
 * distinction lives on the audit row as `voice_tracked`, so a report can say "not tracked"
 * instead of silently claiming everyone had zero voice time.
 */

export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS activity_audits (
            audit_id        INT AUTO_INCREMENT PRIMARY KEY,
            guild_id        VARCHAR(20)  NOT NULL,
            window_days     INT          NOT NULL DEFAULT 90,
            status          VARCHAR(16)  NOT NULL DEFAULT 'running'
                            COMMENT 'running | complete | failed',
            voice_tracked   TINYINT(1)   NOT NULL DEFAULT 0
                            COMMENT '0 = no voice log covers this window; report must not claim zero',
            voice_from      TIMESTAMP    NULL DEFAULT NULL
                            COMMENT 'earliest voice row for the guild — if later than the window start, voice is partial',
            started_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at    TIMESTAMP    NULL DEFAULT NULL,
            requested_by    VARCHAR(20)  NULL DEFAULT NULL,
            source          VARCHAR(16)  NOT NULL DEFAULT 'command'
                            COMMENT 'command | dashboard | scheduled',
            totals          LONGTEXT     NULL DEFAULT NULL COMMENT 'JSON summary',
            scanned         LONGTEXT     NULL DEFAULT NULL COMMENT 'JSON coverage: containers, denied, api calls',
            posted_messages LONGTEXT     NULL DEFAULT NULL COMMENT 'JSON [{channelId, messageIds[]}] for edit-in-place',
            error_text      TEXT         NULL DEFAULT NULL,
            KEY idx_guild_started (guild_id, started_at),
            KEY idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS activity_audit_members (
            audit_id          INT          NOT NULL,
            user_id           VARCHAR(20)  NOT NULL,
            username          VARCHAR(64)  NULL DEFAULT NULL,
            display_name      VARCHAR(64)  NULL DEFAULT NULL,
            is_bot            TINYINT(1)   NOT NULL DEFAULT 0,
            in_guild          TINYINT(1)   NOT NULL DEFAULT 1
                              COMMENT '0 = was active in the window but has since left',
            joined_guild_at   TIMESTAMP    NULL DEFAULT NULL,
            messages          INT          NOT NULL DEFAULT 0,
            channels_posted   INT          NOT NULL DEFAULT 0,
            first_post        TIMESTAMP    NULL DEFAULT NULL,
            last_post         TIMESTAMP    NULL DEFAULT NULL,
            voice_seconds     INT          NOT NULL DEFAULT 0,
            voice_sessions    INT          NOT NULL DEFAULT 0,
            voice_last        TIMESTAMP    NULL DEFAULT NULL,
            PRIMARY KEY (audit_id, user_id),
            KEY idx_audit_messages (audit_id, messages),
            KEY idx_audit_voice (audit_id, voice_seconds)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS activity_audit_members');
    await db.execute('DROP TABLE IF EXISTS activity_audits');
}
