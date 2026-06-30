/**
 * Migration 138 — per-user linked Spotify accounts (Spoticord model).
 *
 * Each user can link their OWN Spotify Premium account via `/spotify link`. We store
 * their go-librespot credentials (the contents of state.json) ENCRYPTED with the same
 * AES-256-GCM service used for custom bot tokens. When that user plays a Spotify link,
 * the session manager spins up a go-librespot instance from these creds so playback
 * runs on THEIR account (shows in their Spotify, uses their Premium). The owner account
 * is the shared fallback for users who haven't linked.
 *
 *   credentials   = JSON.stringify({iv, encryptedData, authTag}) of the state.json blob
 *   spotify_user  = their Spotify username (display only)
 *   api_port      = stable port assigned to their go-librespot instance
 */
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS spotify_links (
      user_id       VARCHAR(20)  PRIMARY KEY,
      credentials   TEXT         NOT NULL,
      spotify_user  VARCHAR(255) NULL,
      device_name   VARCHAR(100) NULL,
      api_port      INT          NULL,
      linked_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      last_used_at  TIMESTAMP    NULL
    )
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS spotify_links').catch(() => {});
}
