// Create a "Sanctuary Guest" role for the Kitsune guild that grants temporary
// view/connect/speak access to the Kitsune Sanctuary voice channel
// (1502435691412459540). Owner (wicked_pinay) toggles this role on users
// manually via Discord's right-click → Roles menu for rotating-basis access.
// Idempotent: reuses the role if it already exists by name.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';

const GUILD_ID     = '1469931133981687873';
const BOT_ID       = '1498486251576229958';
const SANCTUARY_ID = '1502435691412459540';

const ROLE_NAME  = 'Sanctuary Guest';
const ROLE_COLOR = 0xf5b1d9; // soft pink — distinct from existing role colors

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
  STREAM:               1n << 9n,
  USE_VAD:              1n << 25n,
};

// Voice channel access — what a guest can actually do in the Sanctuary
const GUEST_ALLOW = BIT.VIEW_CHANNEL | BIT.CONNECT | BIT.SPEAK | BIT.STREAM
                  | BIT.USE_VAD | BIT.READ_MESSAGE_HISTORY | BIT.SEND_MESSAGES
                  | BIT.EMBED_LINKS | BIT.ATTACH_FILES | BIT.USE_EXTERNAL_EMOJIS
                  | BIT.ADD_REACTIONS;

const conn = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [rows] = await conn.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
await conn.end();
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

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

// 1. Look for existing role by name
const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
let guestRole = roles.find(r => r.name === ROLE_NAME);

if (guestRole) {
  console.log(`✓ Role already exists: ${ROLE_NAME} (${guestRole.id})`);
  // Make sure its perms are clean (0 guild-level) and color is what we want
  if (BigInt(guestRole.permissions) !== 0n || guestRole.color !== ROLE_COLOR) {
    await api('PATCH', `/guilds/${GUILD_ID}/roles/${guestRole.id}`, {
      permissions: '0', color: ROLE_COLOR,
    });
    console.log(`  ↪ reset perms to 0 + color to #${ROLE_COLOR.toString(16).padStart(6, '0')}`);
  }
} else {
  guestRole = await api('POST', `/guilds/${GUILD_ID}/roles`, {
    name: ROLE_NAME,
    permissions: '0',     // No guild-level powers — pure channel-override anchor
    color: ROLE_COLOR,
    hoist: false,
    mentionable: false,
  });
  console.log(`✓ Created role: ${ROLE_NAME} (${guestRole.id}) — color #${ROLE_COLOR.toString(16).padStart(6, '0')}`);
}

// 2. Add channel overwrite on Sanctuary for the role
await api('PUT', `/channels/${SANCTUARY_ID}/permissions/${guestRole.id}`, {
  type: 0,  // role overwrite
  allow: GUEST_ALLOW.toString(),
  deny: '0',
});
console.log(`✓ Granted VIEW + CONNECT + SPEAK + STREAM + chat perms to ${ROLE_NAME} on Sanctuary`);

console.log(`\nRole ID: ${guestRole.id}`);
console.log(`\nOwner workflow:`);
console.log(`  • Right-click a user → Roles → toggle "Sanctuary Guest" on/off`);
console.log(`  • Or: /role add @user @Sanctuary Guest (if a role command exists)`);
console.log(`  • Manual removal when access should end`);
process.exit(0);
