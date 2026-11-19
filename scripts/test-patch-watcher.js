// Dry-run a game_patch_watchers row by polling the provider once and posting
// the LATEST item to a debug channel for visual review. Does NOT modify
// last_seen_ids and does NOT enable the watcher. Safe to re-run.
//
// Usage:
//   node scripts/test-patch-watcher.js <watcher_id> [debug_channel_id]
//
// Default debug channel = #bots (1470197942269907126).
import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { PROVIDERS } from '../core/game-patch-watcher-manager.js';
import { EmbedBuilder } from 'discord.js';

const WATCHER_ID = process.argv[2];
const DEBUG_CHANNEL = process.argv[3] || '1470197942269907126'; // #bots

if (!WATCHER_ID) {
  console.error('Usage: node scripts/test-patch-watcher.js <watcher_id> [debug_channel_id]');
  process.exit(1);
}

async function getBotToken(guildId) {
  const [m] = await pool.execute('SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?', [guildId]);
  if (m.length) {
    const [b] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [m[0].bot_id]);
    if (b.length) return encryption.decrypt(JSON.parse(b[0].bot_token));
  }
  return process.env.DISCORD_TOKEN;
}

(async () => {
  const [rows] = await pool.execute('SELECT * FROM game_patch_watchers WHERE id = ?', [WATCHER_ID]);
  if (!rows.length) { console.error('watcher row not found'); process.exit(1); }
  const row = rows[0];
  console.log(`testing watcher #${row.id}: ${row.provider}/${row.game_label} → would-fire-to ${row.channel_id}, debug-to ${DEBUG_CHANNEL}`);

  const provider = PROVIDERS[row.provider];
  if (!provider) { console.error(`unknown provider "${row.provider}"`); process.exit(1); }

  const cfg = row.provider_config ? JSON.parse(row.provider_config) : {};
  console.log('polling provider...');
  const items = await provider(cfg, row);
  console.log(`provider returned ${items.length} items`);
  if (!items.length) {
    console.log('nothing to preview. watcher state unchanged.');
    await pool.end();
    return;
  }
  const sample = items[0];
  console.log(`previewing latest: id=${sample.id}`);
  console.log(`  title:       ${(sample.title || '').slice(0, 100)}`);
  console.log(`  description: ${(sample.description || '').slice(0, 100)}`);
  console.log(`  image:       ${sample.image || '(none)'}`);
  console.log(`  url:         ${sample.url || '(none)'}`);

  const colors = { 'cod-blog': 0xC72C41, 'fortnite-news': 0x751F1F, 'twitter-rss': 0x1DA1F2 };
  const embed = new EmbedBuilder()
    .setColor(colors[row.provider] ?? 0x5865F2)
    .setAuthor({ name: `[TEST] ${row.game_label}` })
    .setTitle((sample.title || '').slice(0, 256) || '(untitled)')
    .setURL(sample.url || null)
    .setDescription((sample.description || '').slice(0, 1900) || '​');
  if (sample.image) embed.setImage(sample.image);

  const token = await getBotToken(row.guild_id);
  const note = `🧪 **Dry-run preview** for watcher #${row.id} (${row.provider}/${row.game_label})\n` +
    `Provider returned ${items.length} current items. If this preview looks right, run:\n` +
    `\`node scripts/enable-patch-watcher.js ${row.id}\`\n` +
    `That marks all ${items.length} as already-seen and flips is_enabled=1 — only NEW items after this point fire to <#${row.channel_id}>.`;

  const r = await fetch('https://discord.com/api/v10/channels/' + DEBUG_CHANNEL + '/messages', {
    method: 'POST',
    headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: note, embeds: [embed.toJSON()], allowed_mentions: { parse: [] } })
  });
  if (r.ok) console.log('posted preview to debug channel ✓');
  else console.log('debug post FAILED', r.status, await r.text());

  console.log(`\nstate unchanged: is_enabled=${row.is_enabled}, last_seen_ids=${row.last_seen_ids ? JSON.parse(row.last_seen_ids).length + ' ids' : 'null'}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
