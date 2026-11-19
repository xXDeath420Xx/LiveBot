/*
 * Free games: make the console/mobile platforms filterable, and add the two stores the
 * enum was missing.
 *
 * Products already carried `platform_xbox` / `platform_playstation` flags, but subscriptions
 * had no matching `filter_*` column, so those flags could not affect delivery — a server had
 * no way to say "console giveaways only" or "no mobile". Switch and VR had no column at all.
 *
 * The store enum gains 'gamerpower' as a last-resort bucket alongside the existing 'other', and
 * subscriptions gain the matching filter columns so `getMatchingSubscriptions` can look up
 * `filter_<store>` for every store a scraper can now emit.
 *
 * Defaults are 1 (opt-out, not opt-in): existing subscriptions were created before these stores
 * had any source, and defaulting to 0 would silently withhold the new coverage from every guild
 * that already set the feature up.
 */

const SUB_COLUMNS = [
    ['filter_battlenet', 'TINYINT(1) DEFAULT 1'],
    ['filter_other', 'TINYINT(1) DEFAULT 1'],
    ['filter_xbox', 'TINYINT(1) DEFAULT 1'],
    ['filter_playstation', 'TINYINT(1) DEFAULT 1'],
    ['filter_switch', 'TINYINT(1) DEFAULT 1'],
    ['filter_android', 'TINYINT(1) DEFAULT 1'],
    ['filter_ios', 'TINYINT(1) DEFAULT 1'],
    ['filter_vr', 'TINYINT(1) DEFAULT 1'],
    // Loot drops are far noisier than game giveaways, so this one is opt-IN.
    ['notify_loot', 'TINYINT(1) DEFAULT 0'],
];

const PRODUCT_COLUMNS = [
    ['platform_switch', 'TINYINT(1) DEFAULT 0'],
    ['platform_vr', 'TINYINT(1) DEFAULT 0'],
];

async function addMissing(db, table, columns) {
    const [existing] = await db.execute(`SHOW COLUMNS FROM ${table}`);
    const have = new Set(existing.map(c => c.Field));
    for (const [name, def] of columns) {
        if (!have.has(name)) {
            await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
        }
    }
}

export async function up(db) {
    await addMissing(db, 'free_games_subscriptions', SUB_COLUMNS);
    await addMissing(db, 'free_games_products', PRODUCT_COLUMNS);

    // Widen the store enum. 'gamerpower' is the bucket for a giveaway whose storefront the
    // aggregator did not name; 'other' stays for anything genuinely unclassifiable.
    await db.execute(`
        ALTER TABLE free_games_products
        MODIFY store ENUM('steam','epic','gog','humble','origin','ubisoft','itch',
                          'prime','battlenet','gamerpower','other') NOT NULL
    `);

    // Widen the kind enum for beta/early-access keys, which GamerPower lists and nothing
    // else produced.
    await db.execute(`
        ALTER TABLE free_games_products
        MODIFY kind ENUM('game','dlc','loot','software','art','ost','book','beta','other')
               NOT NULL DEFAULT 'game'
    `);

    // filter_ubisoft / filter_itch / filter_origin were added defaulting to 0 and no scraper
    // ever produced those stores, so nothing could be filtered by them and no UI ever exposed
    // them — neither the dashboard page nor `/alerts freegames filters` listed anything beyond
    // steam/epic/gog/humble/prime. Their 0 is therefore an unset default, not a choice a server
    // made. Left alone, every existing subscription would silently miss the coverage this
    // migration exists to enable. Flip the default and backfill the rows.
    for (const col of ['filter_ubisoft', 'filter_itch', 'filter_origin']) {
        await db.execute(`ALTER TABLE free_games_subscriptions MODIFY ${col} TINYINT(1) DEFAULT 1`);
        await db.execute(`UPDATE free_games_subscriptions SET ${col} = 1 WHERE ${col} = 0`);
    }

    // notify_prime had the same problem: the Prime scraper has always run, but the column
    // defaults to 0, so Prime games only reached subscriptions created with it explicitly set.
    // Leave it as-is rather than guess — unlike the three above, it has had a live source all
    // along, so a 0 there could be deliberate.
}

export async function down(db) {
    for (const [name] of SUB_COLUMNS) {
        await db.execute(`ALTER TABLE free_games_subscriptions DROP COLUMN IF EXISTS ${name}`).catch(() => {});
    }
    for (const [name] of PRODUCT_COLUMNS) {
        await db.execute(`ALTER TABLE free_games_products DROP COLUMN IF EXISTS ${name}`).catch(() => {});
    }
}
