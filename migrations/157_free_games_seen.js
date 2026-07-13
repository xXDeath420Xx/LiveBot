// "This guild has already been told about this game."
//
// Two things made this necessary, and they pull in opposite directions.
//
// 1. DUPLICATES. When we take over a guild, the incumbent (FreeStuff) has usually been announcing
//    free games there for months — 128 of them in Kabster's case. Nothing in our schema knew that,
//    so a catch-up post would cheerfully announce games the server has already seen.
//
// 2. SILENCE. `free_games_announcements.notified` is a GLOBAL flag: once any guild is notified, it
//    flips to 1 and no guild is ever offered that announcement again. A guild that subscribes today
//    therefore receives NOTHING that is currently free — only games that drop from now on.
//
// So a new guild is simultaneously at risk of being told everything twice and being told nothing at
// all. Both are solved by recording, per guild, which games it has already been shown — regardless
// of WHO showed it. `source` remembers that: 'incumbent' (recovered from the old bot's own posts)
// or 'us'.
//
// The key is a store URL identity (see utils/free-games-key.js), not a title and not our internal
// product id, because that is the only thing our scraper and someone else's announcement share.

export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS free_games_seen (
      id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
      guild_id   VARCHAR(20)  NOT NULL,
      game_key   VARCHAR(190) NOT NULL,  -- e.g. 'steam:1336490', 'epic:nova-lands-4d1788'
      title      VARCHAR(255)     NULL,  -- for humans reading the table; never matched on
      source     ENUM('incumbent','us') NOT NULL DEFAULT 'us',
      seen_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- The whole point: one row per game per guild. Re-seeding is idempotent.
      UNIQUE KEY uq_guild_game (guild_id, game_key),
      KEY idx_guild (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS free_games_seen');
}
