/**
 * Single POST instead of bulk PUT. POST is a different operation that may go
 * to a different rate-limit bucket. Reveals the FULL response headers so we
 * can see if Cloudflare or Discord is throttling.
 */
import { resolveBotForGuild } from '../utils/bot-resolver.js';
import pool from '../utils/db.js';

const GUILD_ID = '1469931133981687873';

// The acting bot comes from guild_bot_mapping — never pinned here.
const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
const BOT_ID = bot.botId;
const token = bot.token;
await pool.end();

const url = `https://discord.com/api/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`;
const headers = {
  Authorization: `Bot ${token}`,
  'Content-Type': 'application/json',
  'User-Agent': 'CertiFriedUtility-deploy (https://certifriedmultitool.com, 1.0)'
};

// Single POST — different operation than PUT
const r = await fetch(url, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    name: 'kitsune_post_test',
    description: 'POST endpoint test',
    type: 1
  })
});

const txt = await r.text();
console.log(`POST status: ${r.status}`);
console.log('ALL headers:');
for (const [k, v] of r.headers.entries()) {
  console.log(`  ${k}: ${v}`);
}
console.log(`body: ${txt.slice(0, 500)}`);
process.exit(0);
