/**
 * Probes Discord's command-create endpoint for Kitsune directly with fetch,
 * so we can see what HTTP status / headers Discord is actually returning
 * (rate-limit window, retry-after, etc) instead of having discord.js's REST
 * handler silently retry until our timeout fires.
 *
 * Prints status + relevant headers + body. NEVER prints the token.
 */
import enc from '../utils/encryption.js';
import pool from '../utils/db.js';

const BOT_ID = '1498486251576229958';
const GUILD_ID = '1469931133981687873';

const [[row]] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
if (!row) { console.error('no bot row'); process.exit(2); }
const token = enc.decrypt(JSON.parse(row.bot_token));

const url = `https://discord.com/api/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`;

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
