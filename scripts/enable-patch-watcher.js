// Atomically prime + enable a game_patch_watchers row.
// Polls the provider ONCE, captures every current item id into last_seen_ids,
// sets is_enabled=1. Future scheduler polls only fire on items NOT in this set.
//
// Usage:
//   node scripts/enable-patch-watcher.js <watcher_id>
import 'dotenv/config';
import pool from '../utils/db.js';
import { PROVIDERS } from '../core/game-patch-watcher-manager.js';

const WATCHER_ID = process.argv[2];
if (!WATCHER_ID) { console.error('Usage: node scripts/enable-patch-watcher.js <watcher_id>'); process.exit(1); }

(async () => {
  const [rows] = await pool.execute('SELECT * FROM game_patch_watchers WHERE id = ?', [WATCHER_ID]);
  if (!rows.length) { console.error('watcher row not found'); process.exit(1); }
  const row = rows[0];

  const provider = PROVIDERS[row.provider];
  if (!provider) { console.error(`unknown provider "${row.provider}"`); process.exit(1); }

  const cfg = row.provider_config ? JSON.parse(row.provider_config) : {};
  console.log(`priming watcher #${row.id} (${row.provider}/${row.game_label})...`);
  const items = await provider(cfg, row);
  console.log(`provider returned ${items.length} items — marking all as already-seen`);

  if (!items.length) {
    console.log('refusing to enable a watcher with 0 items — provider may be temporarily failing.');
    console.log('try again in a few minutes, or check provider connectivity.');
    process.exit(1);
  }

  const ids = items.map(i => i.id);
  await pool.execute(
    'UPDATE game_patch_watchers SET last_seen_ids = ?, last_checked_at = NOW(), is_enabled = 1 WHERE id = ?',
    [JSON.stringify(ids), row.id]
  );
  console.log(`✓ watcher #${row.id} primed with ${ids.length} ids and enabled`);
  console.log(`  next scheduler tick: items NOT in this set will be posted to <#${row.channel_id}>`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
