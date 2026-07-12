// OwO guild boss.
//
// A guild boss is one large enemy the whole server chips away at. Anyone can fight it with their
// battle team; the damage they deal is banked per user, and when the boss's HP reaches zero it is
// defeated and rewards go to everyone who fought (weighted by damage). If nobody finishes it before
// the timer, it "runs away". This mirrors upstream OwO, whose schema is vendored at
// docs/Discord-OwO-Bot-master/secret/CREATE-OWO-TABLES.sql — guild_boss + user_boss. We keep our
// own `owo_` prefix and per-guild id shape (VARCHAR guild_id, matching every other owo table).
//
// Unlike upstream we store the posted message id/channel so the buttons on the announcement can
// keep the Top-10 board and HP bar live, and an expires_at so a scheduled job can retire it.
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS owo_guild_boss (
      guild_id     VARCHAR(20) NOT NULL PRIMARY KEY,
      active       TINYINT(1) NOT NULL DEFAULT 1,
      boss_animal  VARCHAR(50) NOT NULL,
      boss_lvl     INT UNSIGNED NOT NULL,
      boss_hp      INT NOT NULL,            -- remaining HP
      boss_max_hp  INT NOT NULL,            -- HP at spawn (for the bar)
      boss_wp      INT NOT NULL,            -- the boss's attack power
      channel_id   VARCHAR(20) DEFAULT NULL,
      message_id   VARCHAR(20) DEFAULT NULL,
      outcome      ENUM('active','defeated','fled') NOT NULL DEFAULT 'active',
      spawned_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at   DATETIME NOT NULL,
      KEY idx_active (active, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Per-user damage on the CURRENT boss. Cleared (or rolled over) when a new boss spawns. A row is
  // created the first time a user fights; `hits` caps farming and `defeated` marks a wipe.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS owo_boss_damage (
      guild_id    VARCHAR(20) NOT NULL,
      uid         VARCHAR(20) NOT NULL,
      total_dmg   INT UNSIGNED NOT NULL DEFAULT 0,
      hits        INT UNSIGNED NOT NULL DEFAULT 0,
      defeated    TINYINT(1) NOT NULL DEFAULT 0,   -- the boss wiped this user's team
      last_hit_at DATETIME DEFAULT NULL,
      PRIMARY KEY (guild_id, uid),
      KEY idx_guild_dmg (guild_id, total_dmg)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS owo_boss_damage');
  await db.execute('DROP TABLE IF EXISTS owo_guild_boss');
}
