/*
 * Game-news watchers gain a preset identity and per-watcher presentation.
 *
 * `preset_key` points at an entry in core/game-news-presets.js. It is nullable on purpose:
 * a watcher built from a hand-entered RSS URL has no preset, and that is a supported way to
 * use the feature — the catalogue is a convenience, not a constraint.
 *
 * The UNIQUE key from migration 094 was (guild_id, channel_id, provider, game_label), which
 * blocked two RSS watchers on the same feed provider in the same channel even when they
 * pointed at completely different feeds. Widen it to include preset_key so "Riot — VALORANT"
 * and "Riot — League" can coexist.
 */
export async function up(db) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM game_patch_watchers`);
  const have = new Set(cols.map(c => c.Field));

  if (!have.has('preset_key')) {
    await db.execute(
      `ALTER TABLE game_patch_watchers ADD COLUMN preset_key VARCHAR(64) DEFAULT NULL AFTER provider`
    );
  }
  if (!have.has('embed_color')) {
    await db.execute(
      `ALTER TABLE game_patch_watchers ADD COLUMN embed_color VARCHAR(9) DEFAULT NULL AFTER game_label`
    );
  }
  if (!have.has('created_by')) {
    await db.execute(
      `ALTER TABLE game_patch_watchers ADD COLUMN created_by VARCHAR(20) DEFAULT NULL`
    );
  }
  if (!have.has('last_error')) {
    await db.execute(
      `ALTER TABLE game_patch_watchers ADD COLUMN last_error TEXT DEFAULT NULL`
    );
  }
  if (!have.has('last_posted_at')) {
    await db.execute(
      `ALTER TABLE game_patch_watchers ADD COLUMN last_posted_at TIMESTAMP NULL DEFAULT NULL`
    );
  }

  // Widen the uniqueness rule. Drop-then-add so re-running is safe.
  const [idx] = await db.execute(`SHOW INDEX FROM game_patch_watchers WHERE Key_name = 'uniq_watcher'`);
  if (idx.length && !idx.some(i => i.Column_name === 'preset_key')) {
    await db.execute(`ALTER TABLE game_patch_watchers DROP INDEX uniq_watcher`);
  }
  const [idx2] = await db.execute(`SHOW INDEX FROM game_patch_watchers WHERE Key_name = 'uniq_watcher'`);
  if (!idx2.length) {
    await db.execute(
      `ALTER TABLE game_patch_watchers
         ADD UNIQUE KEY uniq_watcher (guild_id, channel_id, provider, game_label, preset_key)`
    );
  }

  // Backfill preset_key for the two hand-created rows that predate the catalogue.
  await db.execute(
    `UPDATE game_patch_watchers SET preset_key = 'call-of-duty'
      WHERE provider = 'cod-blog' AND preset_key IS NULL`
  );
  await db.execute(
    `UPDATE game_patch_watchers SET preset_key = 'fortnite'
      WHERE provider = 'fortnite-news' AND preset_key IS NULL`
  );
}

export async function down(db) {
  for (const col of ['preset_key', 'embed_color', 'created_by', 'last_error', 'last_posted_at']) {
    await db.execute(`ALTER TABLE game_patch_watchers DROP COLUMN IF EXISTS ${col}`).catch(() => {});
  }
}
