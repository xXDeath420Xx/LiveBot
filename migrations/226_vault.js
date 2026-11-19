/*
 * Vault — a private, authenticated large-file transfer area for a hand-picked set of people.
 *
 * Five tables, and the reasons they are separate:
 *
 * vault_members  The allowlist. NOT derived from isSuperAdmin(): the whole point is that a
 *                second person who is not a bot super-admin can use this without being handed
 *                the keys to the entire network. Seeded with the owner and Bear.
 *
 * vault_uploads  In-progress uploads. Cloudflare rejects any request body over 100 MB on the
 *                Free/Pro plans, so a 5 GB file CANNOT arrive as one POST — it arrives as an
 *                append-only sequence of chunks and this row is the cursor. `received_bytes` is
 *                the resume point; it is the authority, not anything the client claims. Rows are
 *                reaped by jobs/vault-cleanup.js once they go stale.
 *
 * vault_files    Completed files. `file_id` doubles as the on-disk name, so nothing a user typed
 *                ever reaches the filesystem — original_name is display data only.
 *
 * vault_share_links
 *                Capability URLs for people outside the allowlist. Only the SHA-256 of the token
 *                is stored: a database dump does not hand out working download links. expires_at
 *                is NOT NULL by design — an eternal link is how a "temporary" share becomes a
 *                permanent public mirror.
 *
 * vault_audit    Who did what. file_id is deliberately NOT a foreign key: the record of a
 *                deletion has to outlive the row it deleted.
 */

async function tableExists(db, table) {
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]);
  return rows.length > 0;
}

export async function up(db) {
  if (!await tableExists(db, 'vault_members')) {
    await db.execute(`
      CREATE TABLE vault_members (
        user_id VARCHAR(20) PRIMARY KEY,
        label VARCHAR(100) NULL,
        added_by VARCHAR(20) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
  }

  if (!await tableExists(db, 'vault_files')) {
    await db.execute(`
      CREATE TABLE vault_files (
        file_id CHAR(32) PRIMARY KEY,
        owner_id VARCHAR(20) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        size_bytes BIGINT UNSIGNED NOT NULL,
        content_type VARCHAR(160) NULL,
        sha256 CHAR(64) NULL,
        note VARCHAR(500) NULL,
        expires_at DATETIME NULL,
        download_count INT UNSIGNED NOT NULL DEFAULT 0,
        last_downloaded_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_vault_files_owner (owner_id),
        INDEX idx_vault_files_expiry (expires_at)
      )`);
  }

  if (!await tableExists(db, 'vault_uploads')) {
    await db.execute(`
      CREATE TABLE vault_uploads (
        upload_id CHAR(32) PRIMARY KEY,
        owner_id VARCHAR(20) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        size_bytes BIGINT UNSIGNED NOT NULL,
        received_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        content_type VARCHAR(160) NULL,
        note VARCHAR(500) NULL,
        retention_days INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_vault_uploads_owner (owner_id),
        INDEX idx_vault_uploads_updated (updated_at)
      )`);
  }

  if (!await tableExists(db, 'vault_share_links')) {
    await db.execute(`
      CREATE TABLE vault_share_links (
        token_hash CHAR(64) PRIMARY KEY,
        file_id CHAR(32) NOT NULL,
        created_by VARCHAR(20) NOT NULL,
        label VARCHAR(120) NULL,
        password_hash VARCHAR(255) NULL,
        expires_at DATETIME NOT NULL,
        max_downloads INT UNSIGNED NULL,
        download_count INT UNSIGNED NOT NULL DEFAULT 0,
        last_used_at DATETIME NULL,
        revoked_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_vault_links_file (file_id),
        INDEX idx_vault_links_expiry (expires_at),
        CONSTRAINT fk_vault_links_file FOREIGN KEY (file_id)
          REFERENCES vault_files (file_id) ON DELETE CASCADE
      )`);
  }

  if (!await tableExists(db, 'vault_audit')) {
    await db.execute(`
      CREATE TABLE vault_audit (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        actor_id VARCHAR(20) NULL,
        action VARCHAR(40) NOT NULL,
        file_id CHAR(32) NULL,
        detail VARCHAR(500) NULL,
        ip VARCHAR(45) NULL,
        user_agent VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_vault_audit_created (created_at),
        INDEX idx_vault_audit_file (file_id)
      )`);
  }

  // Seed the allowlist. INSERT IGNORE so re-running never clobbers a label that has since
  // been edited, and never resurrects a member who was deliberately removed... which it would,
  // so this only runs when the table is empty.
  const [[{ n }]] = await db.execute('SELECT COUNT(*) AS n FROM vault_members');
  if (n === 0) {
    const owner = process.env.BOT_OWNER_ID || '365905620060340224';
    await db.execute(
      'INSERT IGNORE INTO vault_members (user_id, label, added_by) VALUES (?, ?, ?), (?, ?, ?)',
      [owner, 'Owner', owner, '685127470625980501', 'Bear', owner]);
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS vault_audit');
  await db.execute('DROP TABLE IF EXISTS vault_share_links');
  await db.execute('DROP TABLE IF EXISTS vault_uploads');
  await db.execute('DROP TABLE IF EXISTS vault_files');
  await db.execute('DROP TABLE IF EXISTS vault_members');
}
