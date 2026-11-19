/*
 * Temporary guest access: a role handed out by invite (or by hand) that expires
 * unless the holder actually shows up.
 *
 * Three tables because the feature has three genuinely different lifetimes.
 *
 * `temp_access_config` is per-guild and effectively permanent. `temp_role_id` is
 * the marker the reaper keys on; `access_role_ids` is what actually opens the
 * server. Those are deliberately separate: in a guild where every channel is
 * gated on one @Verified role, making the marker role ALSO the access role would
 * mean rewriting ~55 channel overwrites. Granting the existing gate role
 * alongside a zero-permission marker gets the same access for free, and lets the
 * reaper tell "this person only has what we gave them" from "somebody promoted
 * them" without inspecting permissions.
 *
 * `temp_access_invites` exists because Discord never tells you which invite a
 * member used — the only way to know is to remember each invite's use count and
 * notice which one went up. `uses_seen` is that memory. It is per tracked code
 * rather than a snapshot of every invite in the guild: we only care about the
 * handful of codes wired to the temp role, so the bookkeeping stays small and a
 * missed InviteCreate for some unrelated invite can't corrupt attribution.
 *
 * `temp_access_members` is one row per trial, and it is the ONLY list the reaper
 * will ever kick from. Nothing sweeps the guild looking for idle members; if a
 * row was never written, that member is not at risk. `status` is terminal for
 * everything except 'pending', so a resolved trial can never be re-judged.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS temp_access_config (
            guild_id            VARCHAR(20)  NOT NULL,
            enabled             TINYINT(1)   NOT NULL DEFAULT 1,
            temp_role_id        VARCHAR(20)  NOT NULL,
            access_role_ids     TEXT         DEFAULT NULL,
            trial_hours         INT          NOT NULL DEFAULT 24,
            dm_on_kick          TINYINT(1)   NOT NULL DEFAULT 1,
            keep_role_on_pass   TINYINT(1)   NOT NULL DEFAULT 0,
            log_channel_id      VARCHAR(20)  DEFAULT NULL,
            created_by          VARCHAR(20)  DEFAULT NULL,
            created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS temp_access_invites (
            guild_id     VARCHAR(20)  NOT NULL,
            invite_code  VARCHAR(50)  NOT NULL,
            channel_id   VARCHAR(20)  DEFAULT NULL,
            created_by   VARCHAR(20)  DEFAULT NULL,
            max_uses     INT          NOT NULL DEFAULT 0,
            max_age      INT          NOT NULL DEFAULT 0,
            uses_seen    INT          NOT NULL DEFAULT 0,
            active       TINYINT(1)   NOT NULL DEFAULT 1,
            created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, invite_code),
            KEY idx_active (guild_id, active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS temp_access_members (
            id                BIGINT       NOT NULL AUTO_INCREMENT,
            guild_id          VARCHAR(20)  NOT NULL,
            user_id           VARCHAR(20)  NOT NULL,
            source            ENUM('invite','role','manual') NOT NULL DEFAULT 'invite',
            invite_code       VARCHAR(50)  DEFAULT NULL,
            started_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at        TIMESTAMP    NOT NULL,
            first_activity_at TIMESTAMP    NULL DEFAULT NULL,
            activity_kind     VARCHAR(16)  DEFAULT NULL,
            status            ENUM('pending','passed','kicked','exempt','left','cancelled','error')
                              NOT NULL DEFAULT 'pending',
            resolved_at       TIMESTAMP    NULL DEFAULT NULL,
            note              VARCHAR(255) DEFAULT NULL,
            PRIMARY KEY (id),
            -- One live trial per member. A rejoin reuses the row rather than
            -- stacking a second deadline on the same person.
            UNIQUE KEY uniq_guild_user (guild_id, user_id),
            -- The reaper's only query: pending trials past their deadline.
            KEY idx_due (status, expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS temp_access_members');
    await db.execute('DROP TABLE IF EXISTS temp_access_invites');
    await db.execute('DROP TABLE IF EXISTS temp_access_config');
}
