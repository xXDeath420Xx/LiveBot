/*
 * Account-age join gate.
 *
 * Brand new accounts are the raw material of raids, scam waves and ban evasion — an account made
 * minutes ago has no history to judge and nothing to lose. This gate turns account age into an
 * admission rule:
 *
 *   under `kick_under_hours`  → removed on sight, with a DM explaining why
 *   under `apply_under_days`  → removed, but the DM carries an application; staff decide
 *   older                     → nothing happens at all
 *
 * Deliberately NOT built on a quarantine role. The four servers this was written for gate
 * themselves three different ways (verify_config, a rules panel, and one with no gate at all), so
 * anything depending on a role would work in some and silently fail open in the others. Removing
 * the member and talking to them in DMs behaves identically everywhere.
 */
export async function up(db) {
  // `join_gate_config` ALREADY EXISTS. It belongs to the dashboard's security page and /admin,
  // which use it for verification-role gating, and it carries `min_account_age_days`, `action` and
  // `block_default_avatar` columns that NOTHING has ever enforced on join — configurable settings
  // with no code behind them.
  //
  // So this extends that table instead of creating a rival one. A second table called something
  // like `account_gate_config` would have been the third place in this codebase where "minimum
  // account age" is stored, and the first two already disagree with each other.
  //
  // `is_enabled` is left alone — it means "verification gate on" to the dashboard, and hijacking it
  // would tie two unrelated features to one switch. The age gate gets its own.
  const columns = [
    ['age_gate_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['kick_under_hours', 'INT NOT NULL DEFAULT 24'],
    ['apply_under_days', 'INT NOT NULL DEFAULT 7'],
    ['review_channel_id', 'VARCHAR(20) NULL'],
    ['invite_channel_id', 'VARCHAR(20) NULL'],
    ['log_channel_id', 'VARCHAR(20) NULL'],
  ];
  const [existing] = await db.execute('SHOW COLUMNS FROM join_gate_config');
  const have = new Set(existing.map(c => c.Field));
  for (const [name, type] of columns) {
    if (have.has(name)) continue;
    await db.execute(`ALTER TABLE join_gate_config ADD COLUMN ${name} ${type}`);
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS join_gate_applications (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      guild_id           VARCHAR(20)  NOT NULL,
      user_id            VARCHAR(20)  NOT NULL,
      username           VARCHAR(100) NULL,
      account_created_at DATETIME     NULL,
      status             ENUM('pending','approved','denied') NOT NULL DEFAULT 'pending',
      who_they_are       TEXT         NULL,
      how_found          TEXT         NULL,
      why_join           TEXT         NULL,
      submitted_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_by         VARCHAR(20)  NULL,
      decided_at         DATETIME     NULL,
      decision_note      TEXT         NULL,
      review_message_id  VARCHAR(20)  NULL,
      invite_code        VARCHAR(20)  NULL,
      INDEX idx_guild_user (guild_id, user_id),
      INDEX idx_guild_status (guild_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Every gate decision, including the ones that sent nobody anywhere. "The bot ate my join" has to
  // be answerable, and a kick with a failed DM is exactly the case staff need to see.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS join_gate_events (
      id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
      guild_id           VARCHAR(20)  NOT NULL,
      user_id            VARCHAR(20)  NOT NULL,
      username           VARCHAR(100) NULL,
      action             ENUM('kicked_new','kicked_apply','allowed_approved','allowed_pending','failed') NOT NULL,
      account_age_hours  INT          NULL,
      dm_delivered       TINYINT(1)   NOT NULL DEFAULT 0,
      detail             VARCHAR(255) NULL,
      created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_guild_time (guild_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS join_gate_events');
  await db.execute('DROP TABLE IF EXISTS join_gate_applications');
  // join_gate_config is NOT dropped — it predates this migration and another feature owns it.
  for (const c of ['age_gate_enabled', 'kick_under_hours', 'apply_under_days',
    'review_channel_id', 'invite_channel_id', 'log_channel_id']) {
    await db.execute(`ALTER TABLE join_gate_config DROP COLUMN ${c}`).catch(() => {});
  }
}

export default { up, down };
