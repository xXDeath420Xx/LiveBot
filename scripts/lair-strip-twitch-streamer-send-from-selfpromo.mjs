// One-shot: remove the +SEND overwrite for Twitch Streamer on the self-promo channel.
//
// Context: pre-existing Twitch Streamer holders (e.g. dirty_d_dapper, level 0)
// were able to post in #🚀┃self-promo-and-special-events because the channel had
// +SEND overwrites for BOTH Cubs and Twitch Streamer. Twitch Streamer is a
// pingable/status role, not a level reward — it should NOT confer posting rights
// on the level-1 manual-self-promo channel. Only the Cubs (level 1) reward
// should grant SEND there.
//
// REST-only — safe alongside live PM2.

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1216126780767731722';
const BOT_ID   = '1496406792417185802';
const CHANNEL  = '1457541374424387768'; // #🚀┃self-promo-and-special-events
const TWITCH_STREAMER_ROLE = '1414792796912746576';

const [tokenRow] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(tokenRow[0].bot_token));

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${await r.text()}`);
  if (r.status === 204) return null;
  return r.json();
}

const ch = await api('GET', `/channels/${CHANNEL}`);
const overwrites = (ch.permission_overwrites || []).map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));

const idx = overwrites.findIndex(o => o.id === TWITCH_STREAMER_ROLE);
if (idx < 0) {
  console.log('No overwrite for Twitch Streamer found on this channel. Nothing to change.');
  await pool.end();
  process.exit(0);
}

const before = { ...overwrites[idx] };
const SEND = 1n << 11n;
const allow = BigInt(overwrites[idx].allow || '0') & ~SEND;
const deny  = BigInt(overwrites[idx].deny || '0');

if (allow === 0n && deny === 0n) {
  // Empty overwrite — drop it entirely.
  overwrites.splice(idx, 1);
  console.log(`Removed Twitch Streamer overwrite entirely (was allow=${before.allow}, deny=${before.deny}).`);
} else {
  overwrites[idx].allow = String(allow);
  console.log(`Twitch Streamer overwrite updated: allow ${before.allow} → ${overwrites[idx].allow} (deny unchanged at ${overwrites[idx].deny}).`);
}

await api('PATCH', `/channels/${CHANNEL}`, { permission_overwrites: overwrites });
console.log('Channel patched.');

const after = await api('GET', `/channels/${CHANNEL}`);
const afterEntry = (after.permission_overwrites || []).find(o => o.id === TWITCH_STREAMER_ROLE);
console.log('Twitch Streamer overwrite after PATCH:', afterEntry || '(removed)');

await pool.end();
