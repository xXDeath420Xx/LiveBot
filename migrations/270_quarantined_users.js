/*
 * Migration 270: quarantined_users — the roles a member had before they were quarantined.
 *
 * `/admin mod quarantine enable:true` strips every role (except @everyone, managed roles and the
 * quarantine role) and gives the quarantine role. It never saved what it took, so a release could
 * only remove the quarantine role and the member was left with no roles at all. The dashboard's
 * Release button already reads and deletes rows here, but the table never existed.
 *
 *   previous_roles  JSON array of role ids, saved BEFORE the roles are removed
 *   reason          free text (NULL from the slash command, which has no reason option)
 *   quarantined_by  moderator's user id
 *
 * Written by commands/admin/admin-mod-handler.js (quarantine on); read + deleted on release by the
 * same command (enable:false) and by the dashboard route POST /manage/:guildId/release-quarantine.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS quarantined_users (
        guild_id        VARCHAR(20) NOT NULL,
        user_id         VARCHAR(20) NOT NULL,
        previous_roles  LONGTEXT NOT NULL,
        reason          TEXT NULL,
        quarantined_by  VARCHAR(20) NULL,
        quarantined_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

/*
 * Rolling back would throw away the only record of quarantined members' roles, so this refuses
 * while anyone is still quarantined. Release them first (or copy the rows somewhere safe).
 */
export async function down(db) {
    const [tables] = await db.execute("SHOW TABLES LIKE 'quarantined_users'");
    if (!tables.length) return;
    const [[{ n }]] = await db.execute('SELECT COUNT(*) AS n FROM quarantined_users');
    if (Number(n) > 0) {
        throw new Error(`quarantined_users still holds ${n} quarantined member(s) and their saved roles — release them before rolling back`);
    }
    await db.execute('DROP TABLE quarantined_users');
}
