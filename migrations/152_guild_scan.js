// Guild scan + bot retirement.
//
// Backs the dashboard "Analyze & Take Over" tool. A scan walks every readable channel to its
// first message and records, per bot, the distinct *shapes* of message it posts (a "template")
// along with the user messages that triggered them. That evidence is the only thing Discord
// will ever tell us about another bot — there is no API to read another application's commands
// or config — so a bot may only be retired once every one of its templates is attributed to a
// feature we provably reproduce.
//
// Scans are resumable: `guild_scan_channels.oldest_id` is the pagination cursor, so a scan
// killed by a restart picks up exactly where it stopped rather than re-reading history.

async function hasTable(db, table) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
  return Number(rows[0].n) > 0;
}

const TABLES = {
  // One row per scan run.
  guild_scans: `
    CREATE TABLE guild_scans (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      guild_id VARCHAR(20) NOT NULL,
      status ENUM('running','complete','failed','cancelled') NOT NULL DEFAULT 'running',
      depth ENUM('quick','standard','deep') NOT NULL DEFAULT 'deep',
      started_by VARCHAR(20) NULL,
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP NULL DEFAULT NULL,
      heartbeat_at TIMESTAMP NULL DEFAULT NULL,
      channels_total INT UNSIGNED NOT NULL DEFAULT 0,
      channels_done INT UNSIGNED NOT NULL DEFAULT 0,
      messages_scanned BIGINT UNSIGNED NOT NULL DEFAULT 0,
      error TEXT NULL,
      INDEX idx_guild_status (guild_id, status),
      INDEX idx_guild_started (guild_id, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Pagination cursor + per-channel progress. Resume reads `oldest_id`.
  guild_scan_channels: `
    CREATE TABLE guild_scan_channels (
      scan_id INT UNSIGNED NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      channel_name VARCHAR(120) NULL,
      messages_scanned INT UNSIGNED NOT NULL DEFAULT 0,
      oldest_id VARCHAR(20) NULL,
      complete TINYINT(1) NOT NULL DEFAULT 0,
      error VARCHAR(255) NULL,
      PRIMARY KEY (scan_id, channel_id),
      INDEX idx_scan_incomplete (scan_id, complete),
      CONSTRAINT fk_gsc_scan FOREIGN KEY (scan_id) REFERENCES guild_scans(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Every bot (or webhook persona) that has ever posted, and where.
  guild_scan_bots: `
    CREATE TABLE guild_scan_bots (
      scan_id INT UNSIGNED NOT NULL,
      bot_id VARCHAR(32) NOT NULL,
      name VARCHAR(120) NULL,
      kind ENUM('bot','webhook') NOT NULL DEFAULT 'bot',
      present TINYINT(1) NOT NULL DEFAULT 0,
      messages INT UNSIGNED NOT NULL DEFAULT 0,
      first_seen TIMESTAMP NULL DEFAULT NULL,
      last_seen TIMESTAMP NULL DEFAULT NULL,
      channels JSON NULL,
      PRIMARY KEY (scan_id, bot_id),
      CONSTRAINT fk_gsb_scan FOREIGN KEY (scan_id) REFERENCES guild_scans(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Distinct message shapes per bot. `attributed` is the retirement gate.
  guild_scan_templates: `
    CREATE TABLE guild_scan_templates (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      scan_id INT UNSIGNED NOT NULL,
      bot_id VARCHAR(32) NOT NULL,
      template_hash CHAR(16) NOT NULL,
      sample TEXT NULL,
      occurrences INT UNSIGNED NOT NULL DEFAULT 1,
      channels JSON NULL,
      triggers JSON NULL,
      attributed TINYINT(1) NOT NULL DEFAULT 0,
      attributed_to VARCHAR(64) NULL,
      attributed_by VARCHAR(20) NULL,
      UNIQUE KEY uniq_tpl (scan_id, bot_id, template_hash),
      INDEX idx_scan_bot (scan_id, bot_id, attributed),
      CONSTRAINT fk_gst_scan FOREIGN KEY (scan_id) REFERENCES guild_scans(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Retirement bookkeeping. `parity_ready_at` starts the soak clock: it is stamped the first
  // time every gate except the soak window itself passes.
  guild_retire_state: `
    CREATE TABLE guild_retire_state (
      guild_id VARCHAR(20) NOT NULL,
      bot_id VARCHAR(32) NOT NULL,
      parity_ready_at TIMESTAMP NULL DEFAULT NULL,
      retired_at TIMESTAMP NULL DEFAULT NULL,
      retired_by VARCHAR(20) NULL,
      method ENUM('integration','kick') NULL,
      snapshot JSON NULL,
      PRIMARY KEY (guild_id, bot_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

export async function up(db) {
  for (const [name, ddl] of Object.entries(TABLES)) {
    if (await hasTable(db, name)) continue;
    await db.execute(ddl);
  }
}

export async function down(db) {
  for (const name of ['guild_retire_state', 'guild_scan_templates', 'guild_scan_bots', 'guild_scan_channels', 'guild_scans']) {
    await db.execute(`DROP TABLE IF EXISTS ${name}`);
  }
}
