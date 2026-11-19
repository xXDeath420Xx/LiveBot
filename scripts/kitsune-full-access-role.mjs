// Kitsune guild: give three trusted members full access to the server
// WITHOUT Administrator, per Pnay's request:
//   - everything (channels, settings, moderation, role management) ...
//   - ... except her Sanctuary (1502435691412459540), and
//   - ... except handing out administrative roles.
//
// How that maps onto Discord:
//   - A role with every permission bit EXCEPT Administrator. Administrator
//     bypasses every channel overwrite, so it could never be kept out of the
//     Sanctuary; without it, overwrites apply.
//   - Positioned BELOW every admin and mod role (just under MoDs). Manage
//     Roles can only assign/edit roles beneath the holder's HIGHEST role —
//     for xaliria/darkworldwolf1 that's Itto Rikui, for jedipanda88 the
//     managed Kitsune Kits role — so the Owner, Administrator and Co-Owner
//     roles stay out of reach. Manage Roles also can't add a permission the
//     editor lacks, so no role can be given Administrator by them either.
//   - Sanctuary Guest is moved directly under Co-Owner, above Kitsune Kits
//     and every mod role, so none of the three can self-assign it. Its colour
//     is cleared (0): it was never anyone's display colour at pos 4, and
//     up there it would have overridden holders' real colours.
//   - A role ALLOW overwrite on every other channel and category. Guild-level
//     bits lose to channel denies (@everyone/@Verified deny View on the
//     restricted channels) — only Administrator skips overwrites. The allow is
//     the union of every deny bit used anywhere in the guild, so it beats all
//     of them, and it's channel-valid. It goes on categories AND children so
//     synced children stay synced. Member-level denies (type 1) would still
//     win over a role allow; the script reports any on the three members.
//   - Explicit role deny View+Connect on the Sanctuary (it is already hidden
//     by the @everyone/@Verified denies; this is belt-and-braces). It's a
//     ROLE overwrite on purpose: a member-level deny would override Pnay's
//     Sanctuary Guest role, which she rotates on people herself.
//
// Idempotent: reuses the role by name, re-PATCHes perms/position, PUTs are
// last-write-wins, member role PUTs are no-ops when already held.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { PermissionFlagsBits } from 'discord.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD_ID      = '1469931133981687873';
// The acting bot comes from guild_bot_mapping — never pinned here.
const SANCTUARY_ID  = '1502435691412459540';
const CO_OWNER_ROLE = '1469932629003468917'; // Miyamoto Musashi — Sanctuary Guest sits right below
const SANCTUARY_GUEST = '1505675320647352461';
const LOWEST_MOD_ROLE = '1491132060943913091'; // MoDs — Full Access sits right below
const MEMBERS = [
  '477972657384718336', // xaliria
  '249318280244756480', // jedipanda88
  '817782486507454504', // darkworldwolf1
];
const ROLE_NAME = 'Full Access';
const REASON    = 'Full access (no Administrator) per server owner';

const ALL_BUT_ADMIN = Object.values(PermissionFlagsBits)
  .reduce((acc, bit) => acc | bit, 0n) & ~PermissionFlagsBits.Administrator;
const SANCTUARY_DENY = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect;

const DRY = process.argv.includes('--dry-run');

const conn = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const bot = await resolveBotForGuild(GUILD_ID, { db: conn });
await conn.end();

async function api(method, path, body) {
  if (DRY && method !== 'GET') { console.log(`  [dry] ${method} ${path}`, body ? JSON.stringify(body) : ''); return null; }
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: 'Bot ' + bot.token,
      'X-Audit-Log-Reason': REASON,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${(await r.text()).slice(0, 250)}`);
  return r.status === 204 ? null : r.json();
}

// 1. Role
let roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
let role = roles.find(r => r.name === ROLE_NAME);
if (!role) {
  role = await api('POST', `/guilds/${GUILD_ID}/roles`, {
    name: ROLE_NAME, permissions: ALL_BUT_ADMIN.toString(),
    color: 0, hoist: false, mentionable: false,
  });
  console.log(`✓ created role ${ROLE_NAME} ${role?.id ?? '(dry)'}`);
} else if (BigInt(role.permissions) !== ALL_BUT_ADMIN) {
  await api('PATCH', `/guilds/${GUILD_ID}/roles/${role.id}`, { permissions: ALL_BUT_ADMIN.toString() });
  console.log(`✓ reset perms on ${role.id}`);
} else {
  console.log(`✓ role exists ${role.id}, perms already correct`);
}
if (DRY && !role) { console.log('dry run stops here (role not yet created)'); process.exit(0); }

// 2. Positions: ... Co-Owner > Sanctuary Guest > (Kitsune Kits, mod roles) > MoDs > Full Access > ...
roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
const guest = roles.find(r => r.id === SANCTUARY_GUEST);
if (guest.color !== 0) {
  await api('PATCH', `/guilds/${GUILD_ID}/roles/${SANCTUARY_GUEST}`, { color: 0 });
  console.log('✓ cleared Sanctuary Guest colour');
}
const order = roles
  .filter(r => r.id !== GUILD_ID)
  .sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  .map(r => r.id)
  .filter(id => id !== role.id && id !== SANCTUARY_GUEST);
order.splice(order.indexOf(CO_OWNER_ROLE) + 1, 0, SANCTUARY_GUEST);
order.splice(order.indexOf(LOWEST_MOD_ROLE) + 1, 0, role.id);
const byId = new Map(roles.map(r => [r.id, r]));
const moves = order.map((id, i) => ({ id, position: order.length - i }))
  .filter(m => byId.get(m.id).position !== m.position);
if (moves.length) {
  await api('PATCH', `/guilds/${GUILD_ID}/roles`, moves);
  console.log(`✓ repositioned ${moves.length} roles`);
}

// 3. Sanctuary: role-level deny View+Connect
await api('PUT', `/channels/${SANCTUARY_ID}/permissions/${role.id}`, {
  type: 0, allow: '0', deny: SANCTUARY_DENY.toString(),
});
console.log('✓ Sanctuary role deny set');

// 3b. Every other channel: role allow overriding any deny in the guild
const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
let unionDeny = 0n;
for (const ch of channels) for (const o of ch.permission_overwrites) unionDeny |= BigInt(o.deny);
const CHANNEL_ALLOW = unionDeny & ~PermissionFlagsBits.Administrator;
let changed = 0;
for (const ch of channels.sort((a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1))) {
  if (ch.id === SANCTUARY_ID) continue;
  for (const o of ch.permission_overwrites) {
    if (o.type === 1 && MEMBERS.includes(o.id) && BigInt(o.deny) !== 0n)
      console.log(`⚠ member deny for ${o.id} on ${ch.id} ${ch.name}: ${o.deny}`);
  }
  const cur = ch.permission_overwrites.find(o => o.id === role.id);
  if (cur && BigInt(cur.allow) === CHANNEL_ALLOW && BigInt(cur.deny) === 0n) continue;
  for (;;) {
    try {
      await api('PUT', `/channels/${ch.id}/permissions/${role.id}`, { type: 0, allow: CHANNEL_ALLOW.toString(), deny: '0' });
      break;
    } catch (e) {
      const m = /"retry_after":\s*([\d.]+)/.exec(e.message);
      if (!e.message.startsWith('429') || !m) throw e;
      await new Promise(r => setTimeout(r, Math.ceil(parseFloat(m[1]) * 1000) + 250));
    }
  }
  changed++;
}
console.log(`✓ Full Access allow (${CHANNEL_ALLOW}) set on ${changed} channels (${channels.length - 1} total, Sanctuary skipped)`);

// 4. Members
for (const uid of MEMBERS) {
  await api('PUT', `/guilds/${GUILD_ID}/members/${uid}/roles/${role.id}`);
  console.log(`✓ ${uid} has ${ROLE_NAME}`);
}

// 5. Verify
roles = (await api('GET', `/guilds/${GUILD_ID}/roles`))
  .sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
const idx = roles.findIndex(r => r.id === role.id);
console.log('\nHierarchy around the new role:');
for (const r of roles.slice(Math.max(0, idx - 10), idx + 3)) console.log(`  ${r.position} ${r.id} ${r.name}`);
