// scripts/cinema-grant-vc.mjs
// Grant the Cinema selfbot account access to a voice channel so it can join + Go Live.
// Adds a per-member permission overwrite: View Channel + Connect + Speak + Stream.
// Uses the main bot by default; pass a custom bot id to use that bot's token instead
// (required for custom-bot guilds where the main bot isn't a member).
// Usage: node scripts/cinema-grant-vc.mjs <voiceChannelId> [botId]
import dotenv from 'dotenv';
dotenv.config();

const VC = process.argv[2];
const BOT_ID = process.argv[3]; // optional custom bot id
if (!VC) { console.error('usage: node scripts/cinema-grant-vc.mjs <voiceChannelId> [botId]'); process.exit(1); }

const UID = '791459428049223682'; // deathtest_ (Cinema account)
// VIEW_CHANNEL(1<<10) + CONNECT(1<<20) + SPEAK(1<<21) + STREAM(1<<9)
const allow = ((1n << 10n) | (1n << 20n) | (1n << 21n) | (1n << 9n)).toString();

let BOT = process.env.DISCORD_TOKEN;
if (BOT_ID) {
  const encryption = (await import('../utils/encryption.js')).default;
  const pool = (await import('../utils/db.js')).default;
  const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
  if (!rows.length) { console.error(`custom bot ${BOT_ID} not found`); process.exit(1); }
  BOT = encryption.decrypt(JSON.parse(rows[0].bot_token));
}

const res = await fetch(`https://discord.com/api/v10/channels/${VC}/permissions/${UID}`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${BOT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 1, allow, deny: '0' }),
});
if (res.status === 204) console.log(`✅ Cinema account granted View+Connect+Speak+Stream on VC ${VC}${BOT_ID ? ` (via bot ${BOT_ID})` : ''}`);
else console.error(`❌ ${res.status}: ${(await res.text()).slice(0, 200)}`);
process.exit(res.status === 204 ? 0 : 1);
