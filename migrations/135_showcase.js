// Creator Showcase: channels where uploaded music/video is re-hosted off Discord as
// AES-encrypted HLS (no downloadable file) and surfaced via a tokenized player page.
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS showcase_channels (
      channel_id VARCHAR(20) PRIMARY KEY,
      guild_id   VARCHAR(20) NOT NULL,
      enabled    TINYINT(1)  NOT NULL DEFAULT 1,
      added_by   VARCHAR(20),
      created_at TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
      INDEX (guild_id)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS showcase_items (
      id         VARCHAR(24) PRIMARY KEY,
      guild_id   VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      creator_id VARCHAR(20) NOT NULL,
      title      VARCHAR(200),
      kind       ENUM('audio','video') NOT NULL,
      message_id VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (channel_id),
      INDEX (creator_id)
    )
  `);
}
export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS showcase_items');
  await db.execute('DROP TABLE IF EXISTS showcase_channels');
}
