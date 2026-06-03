-- Connected Accounts (OAuth) for CertiFried Multicast — DB: cert_CertiFriedUtility

CREATE TABLE IF NOT EXISTS stream_platform_accounts (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_discord_id  VARCHAR(32) NOT NULL,
  platform          VARCHAR(40) NOT NULL,
  platform_user_id  VARCHAR(128) DEFAULT NULL,
  platform_username VARCHAR(190) DEFAULT NULL,
  access_token      TEXT DEFAULT NULL,        -- JSON of encryption.encrypt()
  refresh_token     TEXT DEFAULT NULL,        -- JSON of encryption.encrypt()
  expires_at        DATETIME DEFAULT NULL,
  scopes            VARCHAR(500) DEFAULT NULL,
  status            ENUM('active','needs_reconnect') NOT NULL DEFAULT 'active',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_owner_platform (owner_discord_id, platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE stream_destinations
  ADD COLUMN account_id  BIGINT UNSIGNED NULL AFTER stream_key_id,
  ADD COLUMN resolution  ENUM('static','dynamic') NOT NULL DEFAULT 'static' AFTER platform,
  ADD COLUMN config_json JSON NULL AFTER dest_stream_key,
  ADD CONSTRAINT fk_dest_account FOREIGN KEY (account_id)
      REFERENCES stream_platform_accounts (id) ON DELETE CASCADE;
