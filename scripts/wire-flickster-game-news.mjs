// Wire per-game Steam news for Flickster's House (guild 1500965606659194982).
//
// Adds `app_news` + `app_price` steam_watchers rows for each game whose
// gated channel + role already exist (created by setup-flickster-game-roles.mjs).
// Idempotent: SELECT-first guard preserves dedup state on re-run.
//
// Pure DB script — no Discord client, no gateway. Safe alongside PM2.

import pool from '../utils/db.js';

const GUILD_ID = '1500965606659194982';

// Steam app IDs verified via the Steam storefront API (`appdetails?appids=…`):
//   730     → Counter-Strike 2
//   513710  → SCUM
//   1144200 → Ready or Not
//   2221490 → Tom Clancy's The Division 2
//   3041230 → Windrose                       (user-provided)
//   2807960 → Battlefield 6                  (current BF on Steam, swapped from 1517290 BF2042)
//   1938090 → Call of Duty                   (umbrella app: MW3 + Warzone + current content)
//   1808500 → ARC Raiders                    (already wired in steam_watchers.id=11)
const GAMES = [
  { name: 'ARC Raiders',    channelId: '1502814405971148800', roleId: '1502814372718710895', steamAppId: 1808500, addAppNews: false, addAppPrice: true  },
  { name: 'Call of Duty',   channelId: '1503186577533304842', roleId: '1503184007142182932', steamAppId: 1938090, addAppNews: true,  addAppPrice: true  },
  { name: 'Windrose',       channelId: '1503186578535743630', roleId: '1503184187941982299', steamAppId: 3041230, addAppNews: true,  addAppPrice: true  },
  { name: 'Counter-Strike 2', channelId: '1503186579491913848', roleId: '1503184088184520795', steamAppId: 730,   addAppNews: true,  addAppPrice: true  },
  { name: 'Battlefield 6', channelId: '1503186580179914763', roleId: '1503184235484151828', steamAppId: 2807960, addAppNews: true,  addAppPrice: true  },
  { name: 'SCUM',           channelId: '1503186581714899054', roleId: '1503184271563690105', steamAppId: 513710,  addAppNews: true,  addAppPrice: true  },
  { name: 'The Division 2', channelId: '1503186583040557126', roleId: '1503184386412118127', steamAppId: 2221490, addAppNews: true,  addAppPrice: true  },
  { name: 'Ready or Not',   channelId: '1503186584952897648', roleId: '1503184569338171393', steamAppId: 1144200, addAppNews: true,  addAppPrice: true  },
];

const VALID_TYPES = new Set(['app_news', 'app_price']);

const log = (...a) => console.log('[flickster-news]', ...a);

async function ensureWatcher(g, watcherType) {
  if (!VALID_TYPES.has(watcherType)) throw new Error(`Invalid watcher_type: ${watcherType}`);

  const [existing] = await pool.execute(
    `SELECT id FROM steam_watchers
     WHERE guild_id = ? AND discord_channel_id = ? AND watcher_type = ? AND steam_id = ?`,
    [GUILD_ID, g.channelId, watcherType, String(g.steamAppId)]
  );
  if (existing.length) {
    log(`  ✓ ${g.name} [${watcherType}] already exists (id=${existing[0].id}) — skipped`);
    return { skipped: true };
  }

  const [res] = await pool.execute(
    `INSERT INTO steam_watchers
       (guild_id, discord_channel_id, watcher_type, steam_id, steam_name,
        mention_role_ids, is_enabled, check_interval_minutes,
        last_update_found_at, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 5, NOW(), NOW())`,
    [
      GUILD_ID,
      g.channelId,
      watcherType,
      String(g.steamAppId),
      g.name,
      JSON.stringify([g.roleId]),
    ]
  );
  log(`  + ${g.name} [${watcherType}] → channel ${g.channelId}, ping <@&${g.roleId}> (id=${res.insertId})`);
  return { skipped: false, id: res.insertId };
}

log(`Wiring Steam news watchers for guild ${GUILD_ID}`);
log(`  ${GAMES.length} games configured. Per-game: app_news + app_price (per plan).`);
log('');

let created = 0;
let skipped = 0;
const errors = [];

for (const g of GAMES) {
  log(`${g.name}  (appid=${g.steamAppId})`);

  if (g.addAppNews) {
    try {
      const r = await ensureWatcher(g, 'app_news');
      if (r.skipped) skipped++; else created++;
    } catch (e) {
      errors.push(`${g.name} app_news: ${e.message}`);
      log(`  ! ${g.name} [app_news] FAILED: ${e.message}`);
    }
  }
  if (g.addAppPrice) {
    try {
      const r = await ensureWatcher(g, 'app_price');
      if (r.skipped) skipped++; else created++;
    } catch (e) {
      errors.push(`${g.name} app_price: ${e.message}`);
      log(`  ! ${g.name} [app_price] FAILED: ${e.message}`);
    }
  }
}

console.log('\n' + '═'.repeat(60));
console.log('GAME NEWS WIRING COMPLETE');
console.log('═'.repeat(60));
console.log(`Created: ${created}    Skipped (already existed): ${skipped}    Errors: ${errors.length}`);
if (errors.length) {
  console.log('\nErrors:');
  for (const e of errors) console.log(`  - ${e}`);
}
console.log(`
Steam Watcher cron (*/5 * * * *) will pick up new rows on its next tick.
First posts land within ~5 minutes of the next Steam news item per game.
The last_update_found_at = NOW() seed prevents historical-news flood on first poll.

To inspect:
  SELECT id, watcher_type, steam_id, steam_name, discord_channel_id, mention_role_ids
  FROM steam_watchers WHERE guild_id = '${GUILD_ID}'
  ORDER BY steam_name, watcher_type;

To force a poll without waiting: /media steam check
To remove a wrong watcher:        /media steam unwatch ...
`);

await pool.end();
