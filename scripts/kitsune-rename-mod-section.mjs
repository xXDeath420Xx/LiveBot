// Rename Kitsune channel 1491130798030585917 from "mod-section" to the
// Mathematical-Script-with-italic-fallback form "𝑀𝑜𝒹𝑒𝓇𝒶𝓉𝒾𝑜𝓃" so it
// pairs visually with #𝐿𝑒𝒶𝒹𝑒𝓇𝓈 (1469932427647516856). Idempotent.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

// The acting bot comes from guild_bot_mapping — never pinned here.
const GUILD_ID   = '1469931133981687873';  // Kitsune (owns the channel below)
const CHANNEL_ID = '1491130798030585917';
const NEW_NAME   = '𝑀𝑜𝒹𝑒𝓇𝒶𝓉𝒾𝑜𝓃';

const conn = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const bot = await resolveBotForGuild(GUILD_ID, { db: conn });
await conn.end();
const token = bot.token;

async function api(method, path, body) {
  const init = {
    method,
    headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const r = await fetch(`https://discord.com/api/v10${path}`, init);
  if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${(await r.text()).slice(0, 250)}`);
  return r.status === 204 ? null : r.json();
}

const cpDump = (s) => [...s].map(c =>
  'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + ` (${c})`
).join(' ');

const before = await api('GET', `/channels/${CHANNEL_ID}`);
console.log(`Before : ${JSON.stringify(before.name)}`);
console.log(`         ${cpDump(before.name)}`);

if (before.name === NEW_NAME) {
  console.log(`✓ Channel name is already current — skipping PATCH.`);
  process.exit(0);
}

await api('PATCH', `/channels/${CHANNEL_ID}`, { name: NEW_NAME });

const after = await api('GET', `/channels/${CHANNEL_ID}`);
console.log(`After  : ${JSON.stringify(after.name)}`);
console.log(`         ${cpDump(after.name)}`);

if (after.name !== NEW_NAME) {
  console.error(`✗ PATCH applied but name mismatch — expected ${JSON.stringify(NEW_NAME)}, got ${JSON.stringify(after.name)}`);
  process.exit(1);
}
console.log(`✓ Renamed ${CHANNEL_ID} → ${NEW_NAME}`);
process.exit(0);
