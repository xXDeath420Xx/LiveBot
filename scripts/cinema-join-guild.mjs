// scripts/cinema-join-guild.mjs
// Captcha-free: add the Cinema selfbot account to a guild via the OFFICIAL
// OAuth2 `guilds.join` flow (no invite, no captcha).
//   1. selfbot authorizes the bot's own application for the guilds.join scope -> code
//   2. exchange code -> user access_token (client_id + client_secret)
//   3. main bot PUT /guilds/{id}/members/{user} with the access_token
// Requires: main bot already in the guild; OAuth app == the bot's application.
//
// Usage: node scripts/cinema-join-guild.mjs <guildId>
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
dotenv.config(); // root .env: DISCORD_TOKEN, DASHBOARD_CLIENT_* , callback
// CINEMA_USER_TOKEN lives only in cinema/.env:
const cinemaEnv = dotenv.parse(readFileSync(path.join(root, '..', 'cinema', '.env')));

const guildId = process.argv[2];
if (!guildId) { console.error('usage: node scripts/cinema-join-guild.mjs <guildId>'); process.exit(1); }

const USER_TOKEN = cinemaEnv.CINEMA_USER_TOKEN;
const USER_ID = '791459428049223682'; // deathtest_ (Cinema account)
const CLIENT_ID = process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DASHBOARD_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const REDIRECT = process.env.DASHBOARD_CALLBACK_URL || process.env.DISCORD_CALLBACK_URL;
const API = 'https://discord.com/api/v10';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9 Chrome/120 Electron/28 Safari/537.36';

function need(k, v) { if (!v) { console.error(`missing ${k}`); process.exit(1); } }
need('CINEMA_USER_TOKEN', USER_TOKEN); need('CLIENT_ID', CLIENT_ID);
need('CLIENT_SECRET', CLIENT_SECRET); need('BOT_TOKEN', BOT_TOKEN); need('REDIRECT', REDIRECT);

// 1) authorize as the selfbot user -> authorization code
async function authorize() {
  const url = `${API}/oauth2/authorize?client_id=${CLIENT_ID}` +
    `&response_type=code&scope=${encodeURIComponent('guilds.join')}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: USER_TOKEN, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ authorize: true, permissions: '0', integration_type: 0 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`authorize ${res.status}: ${text.slice(0, 300)}`);
  const loc = JSON.parse(text).location || '';
  const code = new URL(loc).searchParams.get('code');
  if (!code) throw new Error(`no code in location: ${loc}`);
  return code;
}

// 2) exchange code -> access_token
async function exchange(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
  });
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error(`no access_token: ${text}`);
  return json.access_token;
}

// 3) bot adds the user to the guild (no captcha)
async function addMember(accessToken) {
  const res = await fetch(`${API}/guilds/${guildId}/members/${USER_ID}`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  });
  const text = await res.text();
  if (res.status === 201) return 'added';
  if (res.status === 204) return 'already a member';
  throw new Error(`add member ${res.status}: ${text.slice(0, 300)}`);
}

try {
  console.log('1/3 authorizing selfbot for guilds.join…');
  const code = await authorize();
  console.log('    got code');
  console.log('2/3 exchanging code for access token…');
  const token = await exchange(code);
  console.log('    got access_token');
  console.log(`3/3 adding ${USER_ID} to guild ${guildId}…`);
  const result = await addMember(token);
  console.log(`✅ ${result}`);
} catch (e) {
  console.error('❌', e.message);
  process.exit(1);
}
