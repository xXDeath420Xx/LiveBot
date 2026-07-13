/**
 * Single GET to see what's currently registered on Kitsune.
 * No mutations — GET doesn't count against daily budget.
 */
import enc from '../utils/encryption.js';
import pool from '../utils/db.js';

const BOT_ID = '1498486251576229958';
const GUILD_ID = '1469931133981687873';

const [[row]] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token = enc.decrypt(JSON.parse(row.bot_token));
await pool.end();

const url = `https://discord.com/api/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`;
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
