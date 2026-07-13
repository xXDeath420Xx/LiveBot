// Epic Sprite Tracker: per-user Epic account link for certifriedmultitool.com/sprites.
// Stores ONLY an encrypted Epic refresh token (AES-256-GCM via utils/encryption.js)
// plus a cached copy of the last-synced sprite collection model.
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS epic_sprite_accounts (
      account_id        VARCHAR(40) PRIMARY KEY,
      display_name      VARCHAR(64),
      refresh_token_enc TEXT NOT NULL,
      refresh_expires_at VARCHAR(40),
      state_json        LONGTEXT,
      synced_at         TIMESTAMP NULL,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}
export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS epic_sprite_accounts');
}
