// Ko-fi integration: webhook-driven supporter roles.
//
// Ko-fi POSTs application/x-www-form-urlencoded with a single `data` field holding JSON.
// There is no signature header — authenticity rests on the `verification_token` inside the
// payload, so we store it encrypted and compare in constant time.
//
// The reference implementation (miffens/kofi-discord-bot, MIT) reads the supporter's
// Discord id out of the donation *message*. That breaks on renewals, which carry a blank
// message. We link on `email` instead — Ko-fi sends it on every payment, including
// renewals — and use a one-time code in the message only to establish that link once.
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS kofi_config (
      guild_id            VARCHAR(20) NOT NULL PRIMARY KEY,
      webhook_token       VARCHAR(64) NOT NULL,
      verification_token  TEXT DEFAULT NULL,
      announce_channel_id VARCHAR(20) DEFAULT NULL,
      enabled             TINYINT(1) NOT NULL DEFAULT 1,
      role_duration_days  INT NOT NULL DEFAULT 31,
      thank_you_message   VARCHAR(500) DEFAULT NULL,
      announce_anonymous  TINYINT(1) NOT NULL DEFAULT 0,
      created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_webhook_token (webhook_token)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // A tier matches either by Ko-fi tier name (memberships) or by minimum amount (donations).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS kofi_tiers (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      guild_id    VARCHAR(20) NOT NULL,
      tier_name   VARCHAR(100) DEFAULT NULL,
      min_amount  DECIMAL(10,2) NOT NULL DEFAULT 0,
      role_id     VARCHAR(20) NOT NULL,
      KEY idx_guild (guild_id),
      UNIQUE KEY uniq_guild_role (guild_id, role_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // email is the durable identity across renewals. Stored as a SHA-256 hash: we only ever
  // need equality, and a leaked table should not expose supporters' addresses.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS kofi_links (
      guild_id    VARCHAR(20) NOT NULL,
      email_hash  CHAR(64) NOT NULL,
      user_id     VARCHAR(20) NOT NULL,
      linked_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, email_hash),
      KEY idx_user (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // One-time claim codes a supporter puts in their Ko-fi message to prove the email is theirs.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS kofi_claim_codes (
      code       VARCHAR(16) NOT NULL PRIMARY KEY,
      guild_id   VARCHAR(20) NOT NULL,
      user_id    VARCHAR(20) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      used_at    TIMESTAMP NULL DEFAULT NULL,
      KEY idx_guild_user (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Current entitlement. `expires_at` is bumped on every renewal; a daily job strips the
  // role once it lapses.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS kofi_supporters (
      guild_id        VARCHAR(20) NOT NULL,
      email_hash      CHAR(64) NOT NULL,
      user_id         VARCHAR(20) DEFAULT NULL,
      from_name       VARCHAR(120) DEFAULT NULL,
      tier_name       VARCHAR(100) DEFAULT NULL,
      role_id         VARCHAR(20) DEFAULT NULL,
      last_amount     DECIMAL(10,2) NOT NULL DEFAULT 0,
      currency        VARCHAR(8) DEFAULT NULL,
      lifetime_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      is_subscription TINYINT(1) NOT NULL DEFAULT 0,
      last_payment_at DATETIME DEFAULT NULL,
      expires_at      DATETIME DEFAULT NULL,
      PRIMARY KEY (guild_id, email_hash),
      KEY idx_expiry (guild_id, expires_at),
      KEY idx_user (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Ko-fi retries on non-2xx, so every payment is recorded once and only once.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS kofi_transactions (
      message_id      VARCHAR(64) NOT NULL PRIMARY KEY,
      guild_id        VARCHAR(20) NOT NULL,
      kofi_txn_id     VARCHAR(64) DEFAULT NULL,
      user_id         VARCHAR(20) DEFAULT NULL,
      email_hash      CHAR(64) DEFAULT NULL,
      from_name       VARCHAR(120) DEFAULT NULL,
      type            VARCHAR(32) DEFAULT NULL,
      amount          DECIMAL(10,2) NOT NULL DEFAULT 0,
      currency        VARCHAR(8) DEFAULT NULL,
      tier_name       VARCHAR(100) DEFAULT NULL,
      is_subscription TINYINT(1) NOT NULL DEFAULT 0,
      is_first        TINYINT(1) NOT NULL DEFAULT 0,
      message         VARCHAR(1000) DEFAULT NULL,
      received_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_guild_time (guild_id, received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  for (const t of ['kofi_transactions', 'kofi_supporters', 'kofi_claim_codes',
    'kofi_links', 'kofi_tiers', 'kofi_config']) {
    await db.execute(`DROP TABLE IF EXISTS ${t}`);
  }
}
