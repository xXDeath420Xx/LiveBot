/*
 * Retire the GamerPower aggregator and remove everything it put in the database.
 *
 * WHY IT WAS REMOVED, so nobody re-adds it. Every GamerPower offer links to
 * `gamerpower.com/open/<id>`, a redirect into a third-party giveaway site that typically asks the
 * visitor to register an account, or hands them an archive to download, before it will release a
 * key. Announcing those into a Discord server means telling that server's members to sign up to
 * and download from sites nobody here vets. The objection is the DESTINATION, not the scraping —
 * an aggregator whose links land on a real storefront would be fine.
 *
 * What is left: Steam, Epic, GOG and Amazon Prime Gaming — four first-party scrapers whose links
 * go to the storefront the member already has an account with.
 *
 * WHAT THIS DELETES. Every product the aggregator wrote carries `external_id` prefixed
 * `gamerpower_` (the prefix exists precisely so its rows could never collide with a first-party
 * scraper's), which makes the boundary exact rather than inferred: 91 products at the time of
 * writing — 76 'other', 14 'itch', 1 'ubisoft' — plus the announcements that contained only those
 * products, and the aggregator's scraper-cache row. No first-party row matches the prefix, and no
 * gamerpower row fails to.
 *
 * The subscription `filter_*` / `notify_loot` columns are NOT dropped. Dropping columns is
 * irreversible in a way row deletion is not, and they cost nothing sitting unused. They are simply
 * no longer offered in the dashboard, in `/alerts freegames`, or by the notifier's store
 * whitelist, because no scraper can produce a row they would ever match.
 */

async function tableExists(db, table) {
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]);
  return rows.length > 0;
}

export async function up(db) {
  if (!await tableExists(db, 'free_games_products')) return;

  const [[{ doomed }]] = await db.execute(
    String.raw`SELECT COUNT(*) AS doomed FROM free_games_products WHERE external_id LIKE 'gamerpower\_%'`);

  // Join rows first: free_games_announcement_products has no cascade to lean on.
  if (await tableExists(db, 'free_games_announcement_products')) {
    await db.execute(String.raw`
      DELETE ap FROM free_games_announcement_products ap
        JOIN free_games_products p ON p.id = ap.product_id
       WHERE p.external_id LIKE 'gamerpower\_%'`);
  }

  await db.execute(String.raw`DELETE FROM free_games_products WHERE external_id LIKE 'gamerpower\_%'`);

  // An announcement whose every product just went is now an empty shell. Announcements that also
  // held a first-party product are left intact.
  if (await tableExists(db, 'free_games_announcement_products')) {
    await db.execute(`
      DELETE a FROM free_games_announcements a
       WHERE NOT EXISTS (
         SELECT 1 FROM free_games_announcement_products ap WHERE ap.announcement_id = a.id
       )`);
  }

  if (await tableExists(db, 'free_games_scraper_cache')) {
    await db.execute("DELETE FROM free_games_scraper_cache WHERE platform = 'gamerpower'").catch(() => {});
  }

  // Narrow the store enum back to what a scraper can emit. 'other' stays as the fallback the
  // notifier coerces anything unrecognised to, so an unexpected value can never crash a run.
  await db.execute(`
    ALTER TABLE free_games_products
    MODIFY store ENUM('steam','epic','gog','prime','other') NOT NULL`);

  // 'loot' and 'beta' had no source but the aggregator. 'game' and 'dlc' remain (Steam produces
  // both); the rest of the old list never had a producer at all.
  await db.execute(`
    ALTER TABLE free_games_products
    MODIFY kind ENUM('game','dlc','other') NOT NULL DEFAULT 'game'`);

  console.log(`[219] removed ${doomed} GamerPower product(s) and narrowed the store/kind enums`);
}

export async function down(db) {
  // The rows are gone for good — the next scraper cycle simply will not recreate them, which is
  // the point. This only restores the schema's tolerance for the wider vocabulary.
  await db.execute(`
    ALTER TABLE free_games_products
    MODIFY store ENUM('steam','epic','gog','humble','origin','ubisoft','itch',
                      'prime','battlenet','gamerpower','other') NOT NULL`);
  await db.execute(`
    ALTER TABLE free_games_products
    MODIFY kind ENUM('game','dlc','loot','software','art','ost','book','beta','other')
           NOT NULL DEFAULT 'game'`);
}
