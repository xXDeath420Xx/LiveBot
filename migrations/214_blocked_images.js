/*
 * Operator-managed scam-image blocklist.
 *
 * The blocklist used to be three files on disk — docs/scam.jpg, docs/image.jpg, docs/image2.jpg —
 * named in a literal array in core/image-blocklist.js. Blocking a new image meant committing a
 * binary and editing source, so in practice nothing was ever added: the list had not changed since
 * 2026-07-04 while the campaign kept rotating its artwork. Every image an operator "reported" to
 * be blocked was blocked only if someone remembered to check in a file.
 *
 * This moves the list into the database so `/admin blocklist add` can fill it from a message link,
 * and stores TWO independent fingerprints per image rather than one.
 *
 * Why two. A 64-bit dHash on its own is not selective enough to act on. Measured over 479 distinct
 * images from this repo, unrelated pairs land within Hamming 10 of each other once in every 70
 * pairs — and within 16 once in every 17, which is why the match radius is NOT being widened.
 * dHash is greyscale and records only "is this pixel brighter than the one to its right", so it
 * throws colour away entirely; a 4x4 RGB signature is therefore close to independent of it.
 * Requiring both to agree drops unrelated collisions to one in 309 while genuine re-posts of the
 * same file (re-encode, resize, brighten, screenshot-of-screenshot) still score 0.6-3.4 on colour
 * against a threshold of 14 — roughly four times the headroom they need.
 *
 * `bits_set` is the third guard, and the one that matters most. A smooth gradient or a flat
 * near-uniform image has no horizontal detail, so every neighbour comparison answers the same way
 * and the hash degenerates to all-zeros — which then matches every other flat image at distance 0.
 * assets/rank-presets/forest.png and a jQuery UI gradient from a vendored dependency really do
 * collide at distance 0 for exactly this reason. Storing the popcount lets the matcher refuse to
 * act on an image that carries no information, in either direction.
 */
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS blocked_images (
      id INT AUTO_INCREMENT PRIMARY KEY,
      -- '0' means every guild. A real snowflake scopes the entry to one server, so a guild can
      -- block something specific to it without imposing that on the other 81.
      guild_id VARCHAR(20) NOT NULL DEFAULT '0',
      dhash CHAR(16) NOT NULL,
      -- Popcount of dhash. Outside [6,58] the hash is degenerate and must never be matched on.
      bits_set TINYINT UNSIGNED NOT NULL,
      -- 48 bytes: 4x4 grid of RGB means, hex encoded. Independent of dhash (which is greyscale).
      colour_sig CHAR(96) NOT NULL,
      label VARCHAR(200) NULL,
      added_by VARCHAR(20) NULL,
      source_url TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_guild_hash (guild_id, dhash),
      KEY idx_guild (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // blocked_image_hits already exists (created lazily by core/image-blocklist.js). Its primary key
  // is (guild_id, user_id, channel_id) with INSERT IGNORE, so a hit is recorded once per channel
  // and the row NEVER refreshes — a user who tripped one channel a month ago still carries that
  // channel toward today's ban count. Adding a timestamp we actually update lets the matcher count
  // only a recent burst, which is what "spread across channels" is supposed to mean.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS blocked_image_hits (
      guild_id VARCHAR(20) NOT NULL,
      user_id VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id, channel_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const [cols] = await db.execute('SHOW COLUMNS FROM blocked_image_hits');
  if (!cols.some(c => c.Field === 'last_seen')) {
    await db.execute(
      'ALTER TABLE blocked_image_hits ADD COLUMN last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    );
  }
  const [idx] = await db.execute('SHOW INDEX FROM blocked_image_hits');
  if (!idx.some(i => i.Key_name === 'idx_recent')) {
    await db.execute('CREATE INDEX idx_recent ON blocked_image_hits (guild_id, user_id, last_seen)');
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS blocked_images');
  // blocked_image_hits predates this migration; only the column it added is removed.
  const [cols] = await db.execute('SHOW COLUMNS FROM blocked_image_hits');
  if (cols.some(c => c.Field === 'last_seen')) {
    await db.execute('ALTER TABLE blocked_image_hits DROP COLUMN last_seen');
  }
}
