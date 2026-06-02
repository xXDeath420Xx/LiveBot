-- CertiFried Multicast schema (MariaDB, database: CertiFriedUtility)

CREATE TABLE IF NOT EXISTS stream_keys (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_type    ENUM('discord','guest') NOT NULL,
  owner_id      VARCHAR(64) NOT NULL,
  stream_key    VARCHAR(80) NOT NULL,
  label         VARCHAR(120) DEFAULT NULL,
  enabled       TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME DEFAULT NULL,
  last_used_at  DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stream_key (stream_key),
  KEY idx_owner (owner_type, owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stream_destinations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stream_key_id   BIGINT UNSIGNED NOT NULL,
  platform        VARCHAR(40) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  rtmp_url        VARCHAR(500) NOT NULL,
  dest_stream_key VARCHAR(500) NOT NULL DEFAULT '',
  enabled         TINYINT(1) NOT NULL DEFAULT 1,
  priority        INT NOT NULL DEFAULT 100,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_key (stream_key_id),
  CONSTRAINT fk_dest_key FOREIGN KEY (stream_key_id)
    REFERENCES stream_keys (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stream_sessions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stream_key_id      BIGINT UNSIGNED NOT NULL,
  started_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at           DATETIME DEFAULT NULL,
  duration_seconds   INT DEFAULT NULL,
  destinations_count INT NOT NULL DEFAULT 0,
  status             ENUM('active','ended','error') NOT NULL DEFAULT 'active',
  error_message      VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_key (stream_key_id),
  CONSTRAINT fk_sess_key FOREIGN KEY (stream_key_id)
    REFERENCES stream_keys (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stream_session_targets (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id        BIGINT UNSIGNED NOT NULL,
  destination_id    BIGINT UNSIGNED DEFAULT NULL,
  platform          VARCHAR(40) NOT NULL,
  state             ENUM('connecting','live','failed','ended') NOT NULL DEFAULT 'connecting',
  last_error        VARCHAR(500) DEFAULT NULL,
  bytes_transferred BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_session (session_id),
  CONSTRAINT fk_target_session FOREIGN KEY (session_id)
    REFERENCES stream_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
