// Cat Bot: catnip perks, battlepass quests, and the minigame economy.
//
// Cats stay the collectible; Cat Coins are the spendable currency, earned from catches
// (a cat's rarity value) and spent on catnip perks and the gambling games.
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_wallets (
      guild_id   VARCHAR(20) NOT NULL,
      user_id    VARCHAR(20) NOT NULL,
      coins      BIGINT NOT NULL DEFAULT 100,
      lifetime   BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id),
      KEY idx_guild_coins (guild_id, coins DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // One row per user; every minigame's persistent state lives here.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_game_profile (
      guild_id      VARCHAR(20) NOT NULL,
      user_id       VARCHAR(20) NOT NULL,
      cookies       BIGINT NOT NULL DEFAULT 0,
      bakery_level  INT NOT NULL DEFAULT 0,
      bakery_at     BIGINT NOT NULL DEFAULT 0,
      fish_caught   INT NOT NULL DEFAULT 0,
      best_fish     VARCHAR(32) DEFAULT NULL,
      last_fish_at  BIGINT NOT NULL DEFAULT 0,
      best_pig      INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_game_stats (
      guild_id VARCHAR(20) NOT NULL,
      user_id  VARCHAR(20) NOT NULL,
      game     VARCHAR(16) NOT NULL,
      plays    INT NOT NULL DEFAULT 0,
      wins     INT NOT NULL DEFAULT 0,
      net      BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, game)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Catnip loadout: a perk at a level. Only ACTIVE perks apply on a catch.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_catnip (
      guild_id VARCHAR(20) NOT NULL,
      user_id  VARCHAR(20) NOT NULL,
      perk_id  VARCHAR(24) NOT NULL,
      level    INT NOT NULL DEFAULT 1,
      active   TINYINT(1) NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, perk_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // period = 'YYYY-MM-DD' for dailies, 'YYYY-Www' for weeklies.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_quests (
      guild_id VARCHAR(20) NOT NULL,
      user_id  VARCHAR(20) NOT NULL,
      period   VARCHAR(12) NOT NULL,
      quest_id VARCHAR(24) NOT NULL,
      progress INT NOT NULL DEFAULT 0,
      target   INT NOT NULL,
      claimed  TINYINT(1) NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, period, quest_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_season (
      guild_id VARCHAR(20) NOT NULL,
      user_id  VARCHAR(20) NOT NULL,
      level    INT NOT NULL DEFAULT 1,
      xp       INT NOT NULL DEFAULT 0,
      claimed  INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id),
      KEY idx_guild_level (guild_id, level DESC, xp DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  for (const t of ['catbot_wallets', 'catbot_game_profile', 'catbot_game_stats',
    'catbot_catnip', 'catbot_quests', 'catbot_season']) {
    await db.execute(`DROP TABLE IF EXISTS ${t}`);
  }
}
