import 'dotenv/config';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';

/**
 * What every live announcement currently looks like, across every guild — including the ones
 * only a custom bot can see (the main bot gets 403 there, so each guild is read with its own
 * bot's token, decrypted from `custom_bots`).
 *
 * REST-only: no gateway login, so this is safe to run while PM2 is live.
 *
 * Classification:
 *   PREVIEW — embed image is the platform's live thumbnail (the 'twitch' style)
 *   CARD    — embed image is our uploaded stream.png (the 'card' style). Note Discord reports it
 *             as a cdn.discordapp.com URL with an EMPTY attachments array once the message has
 *             been edited, so an empty attachments list does not mean "no card".
 *   BOTH    — a preview image with the old card still attached underneath. This was a bug:
 *             the edit path only cleared attachments when it had a new file to upload, so
 *             switching an announcement to the preview style left the stale LIVE card bolted on.
 *             Fixed in utils/announcer.js (attachments: [] unconditionally); rows should clear
 *             themselves on the next embed refresh.
 */
let db;
try {
  db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: process.env.DB_PORT || 3306 });

  const [anns] = await db.execute(
    `SELECT guild_id, username, platform, channel_id, message_id FROM live_announcements
     WHERE message_id IS NOT NULL AND message_id <> 'PENDING' ORDER BY id DESC`);
  const [bots] = await db.execute('SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE enabled = 1');
  const [maps] = await db.execute('SELECT guild_id, bot_id FROM guild_bot_mapping');
  const [styles] = await db.execute('SELECT guild_id, scope_type, scope_id, style FROM stream_render_style');
  await db.end(); db = null;

  const botByGuild = new Map(maps.map(m => [m.guild_id, m.bot_id]));
  const tokenByBot = new Map();
  for (const b of bots) {
    try { tokenByBot.set(b.bot_id, { name: b.bot_name, token: encryption.decrypt(JSON.parse(b.bot_token)) }); }
    catch (e) { console.log(`  ! could not decrypt token for ${b.bot_name}: ${e.message}`); }
  }

  console.log(`live announcements: ${anns.length} | custom bots: ${bots.length} | style overrides configured: ${styles.length}\n`);

  const tally = { PREVIEW: 0, CARD: 0, BOTH: 0, NONE: 0, unreachable: 0 };
  for (const a of anns) {
    const botId = botByGuild.get(a.guild_id);
    const entry = botId ? tokenByBot.get(botId) : null;
    const token = entry?.token || process.env.DISCORD_TOKEN;
    const who = entry?.name || 'main bot';

    const res = await fetch(`https://discord.com/api/v10/channels/${a.channel_id}/messages/${a.message_id}`,
      { headers: { Authorization: 'Bot ' + token } });
    if (!res.ok) { tally.unreachable++; console.log(`  ${a.username.padEnd(26)} [${who}] unreachable (HTTP ${res.status})`); continue; }

    const m = await res.json();
    const e = m.embeds?.[0];
    const img = e?.image?.url || '';
    const ourUpload = (m.attachments?.length || 0) > 0 || img.includes('cdn.discordapp.com');
    const hasPreview = !!img && !img.includes('cdn.discordapp.com');
    const kind = hasPreview && ourUpload ? 'BOTH' : ourUpload ? 'CARD' : hasPreview ? 'PREVIEW' : 'NONE';
    tally[kind]++;
    console.log(`  ${a.username.padEnd(26)} [${who.padEnd(18)}] ${kind.padEnd(8)} img=${img.slice(0, 52) || '-'}`);
  }
  console.log('\ntally:', JSON.stringify(tally));
} catch (err) {
  console.log('FAILED:', err.message);
} finally {
  if (db) await db.end().catch(() => {});
}
process.exit(0);
