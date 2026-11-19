/**
 * Probes Discord's command-create endpoint for Kitsune directly with fetch,
 * so we can see what HTTP status / headers Discord is actually returning
 * (rate-limit window, retry-after, etc) instead of having discord.js's REST
 * handler silently retry until our timeout fires.
 *
 * Prints status + relevant headers + body. NEVER prints the token.
 */
import { resolveBotForGuild } from '../utils/bot-resolver.js';
import pool from '../utils/db.js';

// The acting bot comes from guild_bot_mapping — never pinned here.
const GUILD_ID = '1469931133981687873';

const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
const token = bot.token;

const url = `https://discord.com/api/v10/applications/${bot.botId}/guilds/${GUILD_ID}/commands`;

// Empty bulk PUT — Discord will validate auth + rate limit budget without us
// burning a real command create. If this returns 200, we know our token works
// and we have budget. If 429, headers reveal the actual retry-after.
console.log(`Probing GET first to check auth + count existing commands...`);
const g = await fetch(url, {
  method: 'GET',
  headers: {
    Authorization: `Bot ${token}`,
    'User-Agent': 'CertiFriedUtility-probe (https://certifriedmultitool.com, 1.0)'
  }
});
const gBody = await g.text();
console.log(`GET status: ${g.status}`);
console.log(`GET rate-limit headers:`);
for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset-after', 'x-ratelimit-bucket', 'x-ratelimit-scope', 'retry-after']) {
  console.log(`  ${h}: ${g.headers.get(h)}`);
}
if (g.status === 200) {
  try {
    const arr = JSON.parse(gBody);
    console.log(`GET body: array of ${arr.length} existing commands`);
    if (arr.length > 0) console.log(`  first 5 names: ${arr.slice(0, 5).map(c => c.name).join(', ')}`);
  } catch { console.log(`GET body: ${gBody.slice(0, 400)}`); }
} else {
  console.log(`GET body: ${gBody.slice(0, 800)}`);
}

await pool.end();
