// One-shot: grant Itto Rikui role view + participate access to a few staff
// channels (Leaders text, Leaders voice, mod-section, Commands).
import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1469931133981687873';
const BOT_ID   = '1498486251576229958';
const ITTO     = '1470666282280943740';

const BIT = {
  ADD_REACTIONS:        1n << 6n,
  VIEW_CHANNEL:         1n << 10n,
  SEND_MESSAGES:        1n << 11n,
  EMBED_LINKS:          1n << 14n,
  ATTACH_FILES:         1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  USE_EXTERNAL_EMOJIS:  1n << 18n,
  CONNECT:              1n << 20n,
  SPEAK:                1n << 21n,
};

// type 0 = text, 2 = voice
const TARGETS = [
  { id: '1469932427647516856', type: 0, name: '#Leaders (text)' },
  { id: '1469932595574870036', type: 2, name: '#Leaders (voice)' },
  { id: '1491130798030585917', type: 0, name: '#mod-section' },
  { id: '1470675898662654002', type: 0, name: '#Commands' },
];

const TEXT_ALLOW = BIT.VIEW_CHANNEL | BIT.READ_MESSAGE_HISTORY | BIT.SEND_MESSAGES
                 | BIT.EMBED_LINKS | BIT.ATTACH_FILES | BIT.USE_EXTERNAL_EMOJIS | BIT.ADD_REACTIONS;
const VOICE_ALLOW = BIT.VIEW_CHANNEL | BIT.CONNECT | BIT.SPEAK | BIT.USE_EXTERNAL_EMOJIS;

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
  const init = {
    method,
    headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const r = await fetch(`https://discord.com/api/v10${path}`, init);
  if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

for (const t of TARGETS) {
  const allow = t.type === 2 ? VOICE_ALLOW : TEXT_ALLOW;
  await api('PUT', `/channels/${t.id}/permissions/${ITTO}`, {
    type: 0, allow: allow.toString(), deny: '0',
  });
  console.log(`✓ Itto Rikui grant: ${t.name} (${t.id})`);
}

await pool.end();
console.log('\nDone.');
