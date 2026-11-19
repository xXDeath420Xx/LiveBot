/*
 * Role gate for the "Create Giveaway" panel button.
 *
 * Discord filters slash commands by `default_member_permissions` before the
 * interaction ever reaches us — /manage requires Manage Server, so mod-tier
 * roles that only hold Manage Messages can't see it, and no amount of code-side
 * checking can grant it back. A button carries no such gate, so the panel in a
 * giveaways channel is gated here instead: any member holding one of these roles
 * may open the create-giveaway modal.
 *
 * No rows for a guild = fall back to the Manage Messages permission.
 */
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS giveaway_host_roles (
      guild_id VARCHAR(20) NOT NULL,
      role_id VARCHAR(20) NOT NULL,
      added_by VARCHAR(20) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, role_id)
    )
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS giveaway_host_roles');
}

export default { up, down };
