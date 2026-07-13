// scripts/cinema-bypass-screening.mjs
// Set BYPASSES_VERIFICATION on the Cinema account so it can use voice in a
// membership-screening-gated guild (OAuth guilds.join lands the member as pending,
// which Discord blocks from voice — this clears that gate for deathtest_ only).
// Usage: node scripts/cinema-bypass-screening.mjs <guildId> <botIdInGuild>
//   e.g. node scripts/cinema-bypass-screening.mjs 844406178799943730 1438897897289552054
import dotenv from 'dotenv';
dotenv.config();

const G = process.argv[2];
const BOT_ID = process.argv[3];
const U = '791459428049223682'; // deathtest_ (Cinema account)
if (!G || !BOT_ID) { console.error('usage: node scripts/cinema-bypass-screening.mjs <guildId> <botIdInGuild>'); process.exit(1); }

const encryption = (await import('../utils/encryption.js')).default;
const pool = (await import('../utils/db.js')).default;

let TOKEN = process.env.DISCORD_TOKEN;
if (BOT_ID !== 'main') {
  const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
  if (!r.length) { console.error(`bot ${BOT_ID} not found`); process.exit(1); }
  TOKEN = encryption.decrypt(JSON.parse(r[0].bot_token));
}
const H = { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' };

// BYPASSES_VERIFICATION = 1 << 3 = 8
const patch = await fetch(`https://discord.com/api/v10/guilds/${G}/members/${U}`, { method: 'PATCH', headers: H, body: JSON.stringify({ flags: 8 }) });
console.log('PATCH flags=8 ->', patch.status, patch.status === 200 ? '✅' : (await patch.text()).slice(0, 200));
const m = await fetch(`https://discord.com/api/v10/guilds/${G}/members/${U}`, { headers: H }).then(x => x.json());
console.log('pending now:', m.pending, '| flags:', m.flags, m.pending === false ? '✅ gate cleared' : '⚠️ still pending');
process.exit(patch.status === 200 ? 0 : 1);
