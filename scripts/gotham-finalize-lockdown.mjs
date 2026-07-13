// Three follow-ups in The Bat Cave:
//   1. Channel lockdown — ensure every channel EXCEPT #welcome + #rules
//      has no @everyone allow VIEW overwrite, so the guild-level deny wins.
//      Voice channels: same — @everyone can't CONNECT or VIEW unless verified.
//   2. Convert announcement-flavored channels (currently type=0) to type=5.
//   3. Attempt role hierarchy + admin grant on Bot Manager (1503922180176613477).
//      Expected to fail (bot's role is below Bot Manager); surfaces the error.

import 'dotenv/config';

const GUILD = '800157336458231848';
const RULES_CH    = '800256456997863434';
const WELCOME_CH  = '1503938671857106955';
const ANNOUNCE_CHANNELS = [
  '800215763083722784', // #gotham-announcements🗞
  '800183363188162620', // #channel-updates🔔
];
const BOT_MANAGER_ROLE = '1503922180176613477';
const GCPD_ROLE        = '800180555978506251';

const VIEW_CHANNEL   = 1024n;
const SEND_MESSAGES  = 2048n;
const READ_HISTORY   = 65536n;
const CONNECT        = 1n << 20n;
const SPEAK          = 1n << 21n;
const ADMIN          = 8n;

const token = process.env.DISCORD_TOKEN;

async function api(method, path, body) {
  await new Promise(r => setTimeout(r, 60));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 200));
    return api(method, path, body);
  }
  if (!r.ok) {
    return { __err: { status: r.status, body: (await r.text()).slice(0, 250) } };
  }
  return r.status === 204 ? null : r.json();
}

console.log('\n=== Gotham finalize ===\n');

// ─── 1. Channel lockdown ───────────────────────────────────────────────
console.log('[1] Walking channels and stripping @everyone allow VIEW where not desired…');
const channels = await api('GET', `/guilds/${GUILD}/channels`);
const PUBLIC_IDS = new Set([RULES_CH, WELCOME_CH]);

let modified = 0;
for (const ch of channels) {
  if (PUBLIC_IDS.has(ch.id)) continue;
  const overwrites = (ch.permission_overwrites || []).map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
  const everyoneIdx = overwrites.findIndex(o => o.id === GUILD);

  let changed = false;
  if (everyoneIdx >= 0) {
    const allowBefore = BigInt(overwrites[everyoneIdx].allow || '0');
    // Strip allow VIEW + allow READ_HISTORY + allow CONNECT + allow SPEAK
    const stripMask = VIEW_CHANNEL | READ_HISTORY | CONNECT | SPEAK;
    const allowAfter = allowBefore & ~stripMask;
    if (allowAfter !== allowBefore) {
      overwrites[everyoneIdx].allow = String(allowAfter);
      changed = true;
    }
    // If the overwrite is now completely empty (allow=0 deny=0), drop it
    if (overwrites[everyoneIdx].allow === '0' && (overwrites[everyoneIdx].deny || '0') === '0') {
      overwrites.splice(everyoneIdx, 1);
      changed = true;
    }
  }

  if (changed) {
    const r = await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });
    if (r?.__err) console.log(`     ✗ #${ch.name} (${ch.id}): ${r.__err.status} ${r.__err.body.slice(0,100)}`);
    else { console.log(`     ✓ #${ch.name} (${ch.id}): stripped @everyone view/connect/speak/read_history allows`); modified++; }
  }
}
console.log(`     done — ${modified} channel(s) modified.\n`);

// ─── 2. Convert announcement channels to type=5 ────────────────────────
console.log('[2] Converting announcement channels to type 5 (GUILD_ANNOUNCEMENT)…');
for (const cid of ANNOUNCE_CHANNELS) {
  const r = await api('PATCH', `/channels/${cid}`, { type: 5 });
  if (r?.__err) console.log(`     ✗ ${cid}: ${r.__err.status} ${r.__err.body.slice(0,150)}`);
  else console.log(`     ✓ ${cid} #${r.name} → type=${r.type}`);
}
console.log('');

// ─── 3. Role hierarchy + admin on Bot Manager (expected to fail) ─────
console.log('[3] Attempting to grant Administrator + move Bot Manager above The GCPD…');
const roles = await api('GET', `/guilds/${GUILD}/roles`);
const botManager = roles.find(r => r.id === BOT_MANAGER_ROLE);
const gcpd       = roles.find(r => r.id === GCPD_ROLE);
const certifried = roles.find(r => r.name === 'CertiFried Utility');

console.log(`     CertiFried Utility:  position ${certifried?.position}`);
console.log(`     Bot Manager:         position ${botManager?.position}, perms ${botManager?.permissions}`);
console.log(`     The GCPD:            position ${gcpd?.position}, perms ${gcpd?.permissions}`);

if (!botManager || !gcpd) {
  console.log('     ✗ One of the roles not found — aborting.');
} else {
  const currentPerms = BigInt(botManager.permissions);
  const newPerms = currentPerms | ADMIN;
  const newPos = gcpd.position + 1;

  // Try admin grant
  const r1 = await api('PATCH', `/guilds/${GUILD}/roles/${BOT_MANAGER_ROLE}`, { permissions: String(newPerms) });
  if (r1?.__err) console.log(`     ✗ admin grant: ${r1.__err.status} ${r1.__err.body.slice(0,200)}`);
  else console.log(`     ✓ admin grant: perms ${currentPerms} → ${newPerms}`);

  // Try position bump
  const r2 = await api('PATCH', `/guilds/${GUILD}/roles`, [
    { id: BOT_MANAGER_ROLE, position: newPos },
  ]);
  if (r2?.__err) console.log(`     ✗ position bump: ${r2.__err.status} ${r2.__err.body.slice(0,200)}`);
  else console.log(`     ✓ position bump: Bot Manager → position ${newPos}`);
}
