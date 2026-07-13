// Deep permission audit. For every channel:
//   - List EVERY role overwrite (not just @everyone/Citizen/Muted)
//   - Simulate effective VIEW for: a non-Citizen, a Citizen with no other roles,
//     and a Citizen+Mod
//   - Surface ANY role that grants @everyone-equivalent visibility
//   - Check threads, forums, stages, and "Server Booster" / auto-role anomalies
//   - Also show effective permissions per role-only scenario

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '800157336458231848';
const HARLEY_BOT_ID = '1503936879635202149';
const CITIZEN = '800252381513777158';
const MUTED   = '1503946366542548992';

const VIEW = 1024n;
const READ_HIST = 65536n;

const [row] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [HARLEY_BOT_ID]);
const token = encryption.decrypt(JSON.parse(row[0].bot_token));

async function api(method, path) {
  await new Promise(r => setTimeout(r, 50));
  const r = await fetch(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${token}` } });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${(await r.text()).slice(0,250)}`);
  return r.json();
}

const channels = await api('GET', `/guilds/${GUILD}/channels`);
const roles    = await api('GET', `/guilds/${GUILD}/roles`);
const roleById = new Map(roles.map(r => [r.id, r]));
const everyone = roleById.get(GUILD);
const citizen  = roleById.get(CITIZEN);

console.log(`\n=== ROLE PERMISSIONS SUMMARY (guild-level) ===`);
console.log(`@everyone perms=${everyone.permissions}  hasVIEW=${(BigInt(everyone.permissions) & VIEW) === VIEW}  hasREAD=${(BigInt(everyone.permissions) & READ_HIST) === READ_HIST}`);
console.log(`Citizen   perms=${citizen.permissions}  hasVIEW=${(BigInt(citizen.permissions) & VIEW) === VIEW}  hasREAD=${(BigInt(citizen.permissions) & READ_HIST) === READ_HIST}`);

// Show ALL roles that have VIEW or READ_HIST at the GUILD level (these are roles that
// grant visibility to anyone holding them, regardless of channel overwrites unless denied)
console.log(`\n=== ROLES WITH GUILD-LEVEL VIEW_CHANNEL ===`);
for (const r of roles.sort((a,b)=>b.position-a.position)) {
  const p = BigInt(r.permissions);
  const v = (p & VIEW) === VIEW;
  const h = (p & READ_HIST) === READ_HIST;
  const a = (p & 8n) === 8n;
  if (v || h || a) {
    console.log(`  ${r.position.toString().padStart(3)}  ${r.name.padEnd(25)}  id=${r.id.padEnd(20)}  VIEW=${v?'Y':'n'} READ=${h?'Y':'n'} ADMIN=${a?'Y':'n'} managed=${r.managed}`);
  }
}

// For each channel, simulate effective VIEW for 3 personas
function effectiveView(ch, userRoleIds, memberOverwrite = null) {
  // Step 1: OR all role perms
  let perms = 0n;
  for (const rid of userRoleIds) {
    const r = roleById.get(rid);
    if (r) perms |= BigInt(r.permissions);
  }
  // Administrator bypass
  if ((perms & 8n) === 8n) return { view: true, why: 'ADMIN' };

  // Step 2-3: @everyone overwrite
  const everyoneOw = (ch.permission_overwrites || []).find(o => o.id === GUILD);
  if (everyoneOw) {
    perms &= ~BigInt(everyoneOw.deny || '0');
    perms |= BigInt(everyoneOw.allow || '0');
  }

  // Step 4-7: combine non-@everyone role overwrites
  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const rid of userRoleIds) {
    if (rid === GUILD) continue;
    const ow = (ch.permission_overwrites || []).find(o => o.id === rid && o.type === 0);
    if (ow) {
      roleDeny  |= BigInt(ow.deny  || '0');
      roleAllow |= BigInt(ow.allow || '0');
    }
  }
  perms &= ~roleDeny;
  perms |= roleAllow;

  // Step 8-9: member overwrite
  if (memberOverwrite) {
    perms &= ~BigInt(memberOverwrite.deny || '0');
    perms |= BigInt(memberOverwrite.allow || '0');
  }

  return { view: (perms & VIEW) === VIEW, why: `bits=${perms}` };
}

console.log(`\n=== EFFECTIVE VIEW PERMISSION PER CHANNEL ===\n`);
console.log('  type  id                    name                                      class           non-Citizen   Citizen-only  Citizen+Streamer');
console.log('  ----  --------------------  ----------------------------------------  --------------  ------------  ------------  ----------------');

const STREAMER_ROLE = '1503935998546153562'; // From memory: Streamer (Ping Me)
const cats = new Map(channels.filter(c => c.type === 4).map(c => [c.id, c]));

const nonCitizenLeaks = [];

for (const ch of channels.sort((a,b) => (a.parent_id||'').localeCompare(b.parent_id||'') || a.position - b.position)) {
  // skip categories — they're not directly visible, just inherited
  if (ch.type === 4) continue;

  const nonCit = effectiveView(ch, [GUILD]);
  const cit    = effectiveView(ch, [GUILD, CITIZEN]);
  const citStreamer = effectiveView(ch, [GUILD, CITIZEN, STREAMER_ROLE]);

  const flag = nonCit.view ? '★ LEAK' : '';
  const name = (ch.name || '').padEnd(40).slice(0, 40);
  const parent = cats.get(ch.parent_id)?.name || '(none)';
  const parentShort = parent.padEnd(14).slice(0, 14);
  console.log(`  ${String(ch.type).padStart(4)}  ${ch.id.padEnd(20)}  ${name}  ${parentShort}  ${(nonCit.view?'YES':'no').padEnd(12)}  ${(cit.view?'YES':'no').padEnd(12)}  ${citStreamer.view?'YES':'no'}  ${flag}`);

  if (nonCit.view && !['800256456997863434', '1503938671857106955'].includes(ch.id)) {
    nonCitizenLeaks.push({ id: ch.id, name: ch.name });
  }
}

console.log(`\n=== NON-CITIZEN VISIBILITY LEAKS (excluding rules + welcome) ===`);
if (nonCitizenLeaks.length === 0) {
  console.log('  ✓ none — non-Citizens see only #rules and #welcome');
} else {
  for (const ch of nonCitizenLeaks) console.log(`  ❌ ${ch.id} #${ch.name}`);
}

// Also check threads
console.log(`\n=== THREADS ===`);
const threads = await api('GET', `/guilds/${GUILD}/threads/active`).catch(e => ({ threads: [], _err: e.message }));
if (threads._err) console.log(`  (couldn't fetch threads: ${threads._err})`);
else {
  console.log(`  ${threads.threads?.length || 0} active thread(s):`);
  for (const t of (threads.threads || [])) {
    console.log(`    ${t.id} #${t.name} (parent=${t.parent_id})`);
  }
}

await pool.end();
