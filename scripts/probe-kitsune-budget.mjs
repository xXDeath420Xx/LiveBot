/**
 * Single tiny PUT to see if the daily budget has reset or how much is left.
 * Sends 1 fake command; if it succeeds, the budget has at least 1 left.
 */
import enc from '../utils/encryption.js';
import pool from '../utils/db.js';

const BOT_ID = '1498486251576229958';
const GUILD_ID = '1469931133981687873';

const [[row]] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token = enc.decrypt(JSON.parse(row.bot_token));

const url = `https://discord.com/api/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`;
const headers = {
  Authorization: `Bot ${token}`,
  'Content-Type': 'application/json',
  'User-Agent': 'CertiFriedUtility-probe (https://certifriedmultitool.com, 1.0)'
};

// Try a 1-command PUT to test the budget
const r = await fetch(url, {
  method: 'PUT',
  headers,
  body: JSON.stringify([{ name: 'budget_probe', description: 'temp budget test', type: 1 }])
});
const txt = await r.text();
console.log(`status=${r.status}`);
console.log(`headers:`);
for (const h of ['x-ratelimit-remaining', 'x-ratelimit-reset-after', 'x-ratelimit-scope', 'retry-after']) {
  const v = r.headers.get(h);
  if (v) console.log(`  ${h}: ${v}`);
}
console.log(`body: ${txt.slice(0, 400)}`);

await pool.end();
