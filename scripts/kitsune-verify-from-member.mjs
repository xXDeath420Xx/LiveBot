// Simulate Discord's permission resolver from the perspective of a member
// whose ONLY role is @Verified. Reports every channel they can see, and
// flags any whose name suggests staff-only.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID      = '1469931133981687873';
const KITSUNE_ID    = '1498486251576229958';
const VERIFIED_ROLE = '1498502484912635906';
const VIEW = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [KITSUNE_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}` },
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

function normalize(s) {
  if (!s) return '';
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const roles    = await api('GET', `/guilds/${GUILD_ID}/roles`);
const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
const cats     = new Map(channels.filter(c => c.type === 4).map(c => [c.id, c.name]));

const everyoneRole = roles.find(r => r.id === GUILD_ID);
const verifiedRoleObj = roles.find(r => r.id === VERIFIED_ROLE);

console.log('=== @Verified role guild-level permissions ===');
console.log(`  permissions: ${verifiedRoleObj.permissions}`);
console.log(`  has VIEW_CHANNEL at role level: ${(BigInt(verifiedRoleObj.permissions) & VIEW) === VIEW}`);
console.log(`  has ADMIN at role level:        ${(BigInt(verifiedRoleObj.permissions) & ADMINISTRATOR) === ADMINISTRATOR}`);
console.log('');
console.log('=== @everyone role guild-level permissions ===');
console.log(`  has VIEW_CHANNEL at role level: ${(BigInt(everyoneRole.permissions) & VIEW) === VIEW}`);
console.log('');

// Discord permission resolver: per-channel resolution for a member.
// Base = @everyone role perms | sum of role perms.
// Per-channel: @everyone overwrite (allow/deny) applied first, then role overwrites (combined),
// then member overwrites.
// If ADMINISTRATOR or guild owner → all perms.
function memberCanView(ch, memberRoleIds) {
  // 1) base perms from roles
  let base = BigInt(everyoneRole.permissions);
  for (const rid of memberRoleIds) {
    const r = roles.find(x => x.id === rid);
    if (r) base |= BigInt(r.permissions);
  }
  if ((base & ADMINISTRATOR) === ADMINISTRATOR) return true;

  let allow = 0n, deny = 0n;
  const ow = ch.permission_overwrites || [];

  // 2) @everyone overwrite
  const ev = ow.find(o => o.id === GUILD_ID);
  if (ev) {
    base &= ~BigInt(ev.deny || '0');
    base |=  BigInt(ev.allow || '0');
  }

  // 3) role overwrites (combine allow/deny across all matching roles)
  for (const rid of memberRoleIds) {
    const ro = ow.find(o => o.id === rid && o.type === 0);
    if (ro) {
      deny  |= BigInt(ro.deny  || '0');
      allow |= BigInt(ro.allow || '0');
    }
  }
  base &= ~deny;
  base |= allow;

  return (base & VIEW) === VIEW;
}

console.log('=== Channels a "@Verified-only" member can see ===');
console.log('(omits MEMBER-PRIVATE channels with type=1 overwrites since those need invite)\n');

const grouped = {};
for (const ch of channels) {
  if (ch.type === 4) continue;
  const cat = ch.parent_id ? (cats.get(ch.parent_id) || '?') : '— TOP —';
  if (!grouped[cat]) grouped[cat] = [];
  const canSee = memberCanView(ch, [GUILD_ID, VERIFIED_ROLE]);
  grouped[cat].push({ id: ch.id, name: ch.name, normalized: normalize(ch.name), canSee });
}

const STAFF_LOOK = /(found|leader|admin|moderator|owner|wukong|kanrisha|kaishakunin|musashi|lubu|lu bu|^lead$|stafff?|mod-log|mod-section|mod-chat|punish|^ticket|^logs?$|audit|report|backstage)/i;

for (const [cat, list] of Object.entries(grouped)) {
  console.log(`\n📂 ${cat}`);
  for (const c of list) {
    const flag = STAFF_LOOK.test(c.normalized) ? '🔒STAFF?' : '';
    const vis = c.canSee ? '👁 VISIBLE' : '   hidden';
    console.log(`  ${vis}  ${c.id.padEnd(20)}  #${c.name.padEnd(34)}  ${flag}`);
  }
}

await pool.end();
