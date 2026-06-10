/**
 * Migration 124: Level gate for presence Go-Live auto-track.
 *
 * `guild_streamer_auto_track` (events/presenceUpdate.js) auto-adds a member to a
 * guild's stream list when they go live on Twitch. It previously gated only by
 * role (role_id, NULL = any member). This adds an optional LEVEL gate so a guild
 * can require, e.g., Level 5+ before a member is auto-tracked.
 *
 *   min_level INT NOT NULL DEFAULT 0   -- 0 = no level gate (prior behavior)
 *
 * Enforced in autoRegisterStreamer() via the leveling manager. Default 0 keeps
 * every existing auto-track config behaving exactly as before.
 *
 * Idempotent (column-existence check).
 */
async function columnExists(db, table, column) {
  const allowedTables = new Set(['guild_streamer_auto_track']);
  const allowedColumns = new Set(['min_level']);
  if (!allowedTables.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
  if (!allowedColumns.has(column)) throw new Error(`Refusing to inspect unknown column: ${column}`);
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`
  );
  return rows[0].n > 0;
}

export async function up(db) {
  if (!(await columnExists(db, 'guild_streamer_auto_track', 'min_level'))) {
    await db.execute(
      'ALTER TABLE guild_streamer_auto_track ADD COLUMN min_level INT NOT NULL DEFAULT 0 AFTER live_role_id'
    );
  }
}

export async function down(db) {
  if (await columnExists(db, 'guild_streamer_auto_track', 'min_level')) {
    await db.execute('ALTER TABLE guild_streamer_auto_track DROP COLUMN min_level');
  }
}
