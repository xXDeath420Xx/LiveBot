/**
 * Migration 123: Cinema feature.
 *   cinema_config — per-guild config (enabled flag, control role, default VC)
 *   cinema_state  — singleton live-session lock/state (PK=id=0, one row max)
 * Idempotent (whitelist table-existence checks).
 */
async function tableExists(db, table) {
  const allowed = new Set(['cinema_config', 'cinema_state']);
  if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
  );
  return rows[0].n > 0;
}

export async function up(db) {
  if (!(await tableExists(db, 'cinema_config'))) {
    await db.execute(`
      CREATE TABLE cinema_config (
        guild_id        VARCHAR(20) NOT NULL,
        enabled         TINYINT(1) NOT NULL DEFAULT 0,
        control_role_id VARCHAR(20) NULL,
        default_vc_id   VARCHAR(20) NULL,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  if (!(await tableExists(db, 'cinema_state'))) {
    await db.execute(`
      CREATE TABLE cinema_state (
        id               INT NOT NULL,
        guild_id         VARCHAR(20) NOT NULL,
        channel_id       VARCHAR(20) NOT NULL,
        voice_channel_id VARCHAR(20) NOT NULL,
        item_id          VARCHAR(64) NOT NULL,
        item_name        VARCHAR(255) NOT NULL,
        started_by       VARCHAR(20) NOT NULL,
        audio_index      INT NULL,
        sub_index        INT NULL,
        status           ENUM('playing','paused') NOT NULL DEFAULT 'playing',
        position_secs    INT NOT NULL DEFAULT 0,
        panel_message_id VARCHAR(20) NULL,
        started_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS cinema_state');
  await db.execute('DROP TABLE IF EXISTS cinema_config');
}
