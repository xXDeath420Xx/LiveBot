/*
 * Make sprite availability fully live-driven instead of code-driven.
 *
 * Two problems this solves, both caused by Epic changing things with little or
 * no notice:
 *
 *  1. Release timing used to be a hardcoded timestamp in epic-sprites.js, so a
 *     schedule change meant editing code and redeploying. `epic_sprite_release_schedule`
 *     moves it to data — editable at runtime, picked up within ~30s.
 *
 *  2. Even an editable schedule can be wrong (Epic ships early, slips a day, or
 *     silently flips a tier on). `epic_sprite_observed_variants` records every
 *     variant any synced account has actually held. Real ownership is ground
 *     truth and overrides the schedule outright, so the tracker self-corrects
 *     within one sync cycle no matter what the announced date said.
 *
 * Together: the schedule is only ever a *prediction* used to render a countdown
 * before a drop. The instant reality contradicts it, reality wins.
 */
export async function up(db) {
  // Editable release schedule. scope='tier' gates a whole tier across every
  // family (Cube, Gem); scope='family' gates one family (a collab sprite).
  //   release_at  NULL = announced but undated -> "Unreleased", no countdown.
  //   gate=0      = obtainable NOW, row exists only to carry a note
  //                 (e.g. Pollo: stream-event only, not yet in chest rotation).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS epic_sprite_release_schedule (
      scope ENUM('tier','family') NOT NULL,
      item_key VARCHAR(48) NOT NULL,
      release_at BIGINT NULL,
      gate TINYINT(1) NOT NULL DEFAULT 1,
      label VARCHAR(120) NULL,
      note_label VARCHAR(80) NULL,
      note_text TEXT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (scope, item_key)
    )
  `);

  // Global observed-ownership ledger. One row the first time ANY account is
  // seen holding a variant. Append-only on purpose: once a variant has provably
  // reached players it is obtainable forever, even if every owner later
  // extracts it. Cheap to read (~100 rows) and cached in-process.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS epic_sprite_observed_variants (
      variant_name VARCHAR(96) NOT NULL,
      family_token VARCHAR(48) NOT NULL,
      tier_key VARCHAR(24) NOT NULL,
      first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (variant_name),
      KEY idx_tier (tier_key),
      KEY idx_family (family_token)
    )
  `);

  // Seed the current known schedule so behaviour is unchanged at deploy time.
  // Cube: Thursday 2026-07-23 06:00 PT = 13:00 UTC = 1784811600000.
  // Pollo enters chest rotation at the same instant, but is already obtainable
  // via the stream event -> gate=0 (note only, tile stays unlocked).
  await db.execute(
    `INSERT IGNORE INTO epic_sprite_release_schedule
       (scope, item_key, release_at, gate, label, note_label, note_text)
     VALUES
       ('tier','cube',1784811600000,1,'⬢ Cube variants arrive',NULL,NULL),
       ('tier','gem',NULL,1,'◆ Gem variants',NULL,NULL),
       ('family','companystargazer',1784811600000,0,'🐔 Pollo enters chest rotation',
        'Stream event only',
        'Obtainable now, but only through Pollo''s stream event — not yet in the regular chest pool. Enters normal chest rotation alongside the Cube variants on Thursday 2026-07-23 at 6 AM PT.')`
  );
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS epic_sprite_release_schedule');
  await db.execute('DROP TABLE IF EXISTS epic_sprite_observed_variants');
}

export default { up, down };
