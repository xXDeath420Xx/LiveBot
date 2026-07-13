// Discover staff-tier roles in The Bat Cave by checking guild-role permissions
// for any of the moderator-class bits. Writes docs/gotham-staff-roles.json,
// which feeds gotham-harden-channel-perms.mjs.
//
// REST-only via Harley's Bat token — safe alongside live PM2.

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '800157336458231848';
const HARLEY_BOT_ID = '1503936879635202149';

const MUTED_ROLE   = '1503946366542548992';
const CITIZEN_ROLE = '800252381513777158';

// Permission bits we treat as "staff signal"
const PERM_BITS = {
  ADMINISTRATOR:     1n << 3n,   // 8
  KICK_MEMBERS:      1n << 1n,   // 2
  BAN_MEMBERS:       1n << 2n,   // 4
  MANAGE_CHANNELS:   1n << 4n,   // 16
  MANAGE_GUILD:      1n << 5n,   // 32
  MANAGE_MESSAGES:   1n << 13n,  // 8192
  MANAGE_ROLES:      1n << 28n,  // 268435456
  MODERATE_MEMBERS:  1n << 40n,  // 1099511627776
};

const [row] = await pool.execute(
  'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
  [HARLEY_BOT_ID]
);
if (row.length === 0) {
  console.error(`Harley's Bat token (${HARLEY_BOT_ID}) not found in custom_bots`);
  process.exit(1);
}
const token = encryption.decrypt(JSON.parse(row[0].bot_token));

async function api(method, path) {
  await new Promise(r => setTimeout(r, 80));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}` },
  });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 200));
    return api(method, path);
  }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${(await r.text()).slice(0, 250)}`);
  return r.json();
}

function staffBitsHeld(permsStr) {
  const p = BigInt(permsStr || '0');
  const held = [];
  for (const [name, bit] of Object.entries(PERM_BITS)) {
    if ((p & bit) === bit) held.push(name);
  }
  return held;
}

console.log('=== Bat Cave staff-role inventory ===\n');

const roles = await api('GET', `/guilds/${GUILD}/roles`);
roles.sort((a, b) => b.position - a.position);

// Optionally get member counts via a one-page fetch (1000 cap). For Bat Cave
// (~170 members) one page is enough.
const members = await api('GET', `/guilds/${GUILD}/members?limit=1000`);
const memberCountByRole = new Map();
for (const m of members) {
  for (const rid of m.roles) {
    memberCountByRole.set(rid, (memberCountByRole.get(rid) || 0) + 1);
  }
}

const humanStaff = [];
const botStaff = [];
const rows = [];

for (const r of roles) {
  if (r.id === GUILD) continue;                // @everyone
  if (r.id === MUTED_ROLE) continue;
  if (r.id === CITIZEN_ROLE) continue;

  const bits = staffBitsHeld(r.permissions);
  if (bits.length === 0) continue;

  const memberCount = memberCountByRole.get(r.id) || 0;
  const entry = {
    id: r.id,
    name: r.name,
    position: r.position,
    permissions: r.permissions,
    bits,
    managed: !!r.managed,
    memberCount,
    isHoist: r.hoist,
    color: r.color,
  };

  if (r.managed) botStaff.push(entry);
  else humanStaff.push(entry);

  rows.push({
    pos:   r.position,
    name:  r.name,
    id:    r.id,
    bits:  bits.join(','),
    bot:   r.managed ? 'YES' : 'no',
    count: memberCount,
  });
}

console.log(`${rows.length} role(s) with staff-class permissions:\n`);
console.log('  pos  name                          id                    bits                                          isBot  members');
console.log('  ---  ----------------------------  --------------------  --------------------------------------------  -----  -------');
for (const r of rows) {
  const name = r.name.padEnd(30).slice(0, 30);
  const bits = r.bits.padEnd(45).slice(0, 45);
  console.log(`  ${String(r.pos).padStart(3)}  ${name}  ${r.id.padEnd(20)}  ${bits}  ${r.bot.padEnd(5)}  ${r.count}`);
}

console.log(`\nHuman staff roles (${humanStaff.length}):`);
for (const r of humanStaff) console.log(`  ✓ ${r.name} (${r.id}) — ${r.memberCount} member(s), bits=${r.bits.join(',')}`);

console.log(`\nBot-integration staff roles (${botStaff.length}):`);
for (const r of botStaff) console.log(`  • ${r.name} (${r.id}) — managed bot role, bits=${r.bits.join(',')}`);

const outPath = path.join(process.cwd(), 'docs', 'gotham-staff-roles.json');
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify({
  guildId: GUILD,
  generatedAt: new Date().toISOString(),
  humanStaff: humanStaff.map(r => ({ id: r.id, name: r.name, position: r.position, bits: r.bits })),
  botStaff: botStaff.map(r => ({ id: r.id, name: r.name, position: r.position, bits: r.bits })),
}, null, 2));

console.log(`\nWrote ${outPath}`);

await pool.end();
