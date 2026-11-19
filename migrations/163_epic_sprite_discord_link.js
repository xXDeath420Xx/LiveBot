// Discord integration for the Sprite Tracker — two tables:
//
//   epic_sprite_discord_links: which sprite account a Discord user is linked to.
//     One Discord user can only be linked to one sprite account at a time (PK on
//     discord_user_id). Sprite accounts can have multiple Discord users looking
//     at them (public shares work the same way anyway).
//
//   epic_sprite_discord_embeds: bot messages we auto-refresh when the linked
//     account's state_json changes. Each row = one embed we own in some
//     channel. Type is 'collection' (the sprite grid summary) or 'buyback'
//     (buy-back list). When the underlying account's periodic sync detects a
//     change, we fetch these rows and edit each message via bot API.
//
// Linking is done via 6-digit codes generated on the sprite tracker web side
// and consumed by `/sprites link <code>` in Discord. Codes live in a Redis-like
// in-memory cache with a 5-min TTL — no DB table needed for them.

export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS epic_sprite_discord_links (
      discord_user_id VARCHAR(30) NOT NULL,
      sprite_account_id VARCHAR(64) NOT NULL,
      linked_at DATETIME NOT NULL,
      PRIMARY KEY (discord_user_id),
      KEY sprite_account_id (sprite_account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS epic_sprite_discord_embeds (
      id INT AUTO_INCREMENT PRIMARY KEY,
      -- The sprite account this embed shows. On unlink, embeds for that account are deleted.
      sprite_account_id VARCHAR(64) NOT NULL,
      -- Guild + channel + message the bot posted. On message_id 404 we mark
      -- the row as broken and stop attempting refreshes.
      guild_id VARCHAR(30) NOT NULL,
      channel_id VARCHAR(30) NOT NULL,
      message_id VARCHAR(30) NOT NULL,
      -- Discord user who initiated the embed (owner for /sprites remove-embed).
      posted_by_discord_id VARCHAR(30) NOT NULL,
      -- 'collection' or 'buyback' — determines which builder we call.
      embed_type ENUM('collection', 'buyback') NOT NULL,
      -- Bot ID that posted the message (main bot vs custom bot per-guild).
      bot_id VARCHAR(30) NOT NULL,
      -- Broken flag: set when refresh attempts hit 404 (channel/message deleted).
      -- Cleared by re-posting via /sprites embed.
      broken TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL,
      updated_at DATETIME,
      last_refresh_at DATETIME NULL,
      KEY sprite_account_id (sprite_account_id),
      KEY guild_channel (guild_id, channel_id),
      UNIQUE KEY one_type_per_account_channel (sprite_account_id, channel_id, embed_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS epic_sprite_discord_embeds');
  await db.execute('DROP TABLE IF EXISTS epic_sprite_discord_links');
}
