// Discord's "onboarding default channels" list (Server Settings → Onboarding →
// Default Channels) forces every channel inside the listed channels/categories
// to be @everyone-readable, even when onboarding itself is disabled.
//
// Bat Cave's default_channel_ids currently includes 5 CATEGORIES, which
// cascades to every channel inside them — blocking my CITIZEN-class @everyone
// deny VIEW from being applied.
//
// Reset default_channel_ids to just [#rules, #welcome] — the only two channels
// that genuinely must be visible to new joiners pre-verification.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '800157336458231848';
const HARLEY_BOT_ID = '1503936879635202149';
const RULES_CH = '800256456997863434';
const WELCOME_CH = '1503938671857106955';

const [row] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [HARLEY_BOT_ID]);
const token = encryption.decrypt(JSON.parse(row[0].bot_token));

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${method} ${path} → ${r.status}: ${t.slice(0,250)}`);
  }
  return r.status === 204 ? null : r.json();
}

const before = await api('GET', `/guilds/${GUILD}/onboarding`);
console.log('Before:');
console.log('  enabled:', before.enabled);
console.log('  default_channel_ids:', before.default_channel_ids);
console.log('');

const after = await api('PUT', `/guilds/${GUILD}/onboarding`, {
  prompts: before.prompts || [],
  default_channel_ids: [RULES_CH, WELCOME_CH],
  enabled: false,
  mode: before.mode || 0,
});

console.log('After:');
console.log('  enabled:', after.enabled);
console.log('  default_channel_ids:', after.default_channel_ids);

await pool.end();
