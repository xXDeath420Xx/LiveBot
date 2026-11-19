/*
 * Officially-announced sprites that aren't in Epic's catalog yet.
 *
 * The availability model is catalog-driven: a sprite only gets a grid tile once
 * Epic serves it. That's correct, but it left a gap — when Epic publicly
 * announces a sprite days ahead of shipping it (John Wick, dated for the v41.30
 * drop), the /info "rumored sprites" check reported it as "no catalog entry, no
 * DisplayName match", i.e. indistinguishable from a debunked rumor like Joker.
 * That read as "not coming" when it's confirmed for a specific date.
 *
 * This table holds those confirmed-but-unshipped announcements. It's the
 * reporting layer only — it does NOT fabricate a grid tile (we don't have the
 * art or the codename). verifyRumors() checks the live catalog/pak FIRST, so
 * the instant the sprite actually ships it's reported as shipped and the
 * announcement row becomes redundant (delete it, or leave it — shipped wins).
 *
 * family_token is null until we learn the catalog codename; filling it later
 * lets the reporting reconcile the announcement to the real family.
 */
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS epic_sprite_announced (
      slug VARCHAR(48) NOT NULL,
      name VARCHAR(80) NOT NULL,
      release_at BIGINT NULL,
      rarity VARCHAR(24) NULL,
      ability TEXT NULL,
      how_to_get TEXT NULL,
      source_url VARCHAR(300) NULL,
      family_token VARCHAR(48) NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (slug)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // Seed John Wick — Thursday 2026-07-30 06:00 PT = 13:00 UTC = 1785416400000.
  // Source: Vice (fortnite-john-wick-sprite-release-date-powers-how-to-get) +
  // corroborated by Epic's own hotfix ComingSoonTimestamp (next_drop 07-30 13:00Z).
  await db.execute(
    `INSERT INTO epic_sprite_announced
       (slug, name, release_at, rarity, ability, how_to_get, source_url)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       name=VALUES(name), release_at=VALUES(release_at), rarity=VALUES(rarity),
       ability=VALUES(ability), how_to_get=VALUES(how_to_get), source_url=VALUES(source_url)`,
    [
      'john-wick',
      'John Wick',
      1785416400000,
      'Mythic',
      'Reveals nearby enemies after you knock or eliminate another player.',
      'Exclusive to The Simpsons Fortnite Reload (Springfield): claim it there via the Reload Portable Extractor, from a defeated carrier, in Normal or Sprite Chests, or by winning a Reload match. Claiming it in Reload unlocks it for Battle Royale and other modes.',
      'https://www.vice.com/en/article/fortnite-john-wick-sprite-release-date-powers-how-to-get/',
    ],
  );
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS epic_sprite_announced');
}

export default { up, down };
