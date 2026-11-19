/**
 * Single GET to see what's currently registered on Kitsune.
 * No mutations — GET doesn't count against daily budget.
 */
import { resolveBotForGuild } from '../utils/bot-resolver.js';
import pool from '../utils/db.js';

// The acting bot comes from guild_bot_mapping — never pinned here.
const GUILD_ID = '1469931133981687873';

const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
const token = bot.token;
await pool.end();

const url = `https://discord.com/api/v10/applications/${bot.botId}/guilds/${GUILD_ID}/commands`;
const r = await fetch(url, {
  method: 'GET',
  headers: {
    Authorization: `Bot ${token}`,
    'User-Agent': 'CertiFriedUtility-probe (https://certifriedmultitool.com, 1.0)'
  }
});
const txt = await r.text();
console.log(`status=${r.status}`);
console.log('rate-limit headers:');
for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset-after', 'x-ratelimit-bucket', 'x-ratelimit-scope', 'retry-after']) {
  const v = r.headers.get(h);
  if (v) console.log(`  ${h}: ${v}`);
}
if (r.status === 200) {
  const arr = JSON.parse(txt);
  console.log(`currently registered: ${arr.length} commands`);
  console.log(`names: ${arr.map(c => c.name).sort().join(', ')}`);
} else {
  console.log(`body: ${txt.slice(0, 500)}`);
}
process.exit(0);
