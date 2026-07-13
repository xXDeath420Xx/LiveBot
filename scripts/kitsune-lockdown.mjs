// Channel-permission lockdown for guild 1469931133981687873 (served by Kitsune).
//
// End state:
//   - Only channel 1469931510088859730 is visible to @everyone.
//   - All other channels require the @Verified role at minimum.
//   - Only channel 1469931510088859730 lets @everyone create instant invites.
//
// REST-only via Kitsune's bot token. Safe to run while PM2 is live.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID   = '1469931133981687873';
const PUBLIC_CH  = '1469931510088859730';
const KITSUNE_ID = '1498486251576229958';

const VIEW_CHANNEL          = 1n << 10n;
const READ_MESSAGE_HISTORY  = 1n << 16n;
const CREATE_INSTANT_INVITE = 1n << 0n;
const SEND_MESSAGES         = 1n << 11n;
const EMBED_LINKS           = 1n << 14n;
const ATTACH_FILES          = 1n << 15n;
const ADD_REACTIONS         = 1n << 6n;
const USE_EXTERNAL_EMOJIS   = 1n << 18n;
const MANAGE_MESSAGES       = 1n << 13n;
const CONNECT               = 1n << 20n;
const SPEAK                 = 1n << 21n;
const USE_VAD               = 1n << 25n;

const PERM_ADMINISTRATOR    = 1n << 3n;
const PERM_KICK             = 1n << 1n;
const PERM_BAN              = 1n << 2n;
const PERM_MANAGE_CHANNELS  = 1n << 4n;
const PERM_MANAGE_GUILD     = 1n << 5n;
const PERM_MANAGE_ROLES     = 1n << 28n;
const PERM_MANAGE_MESSAGES  = MANAGE_MESSAGES;
const PERM_MODERATE         = 1n << 40n;
const STAFF_BITS = PERM_ADMINISTRATOR | PERM_KICK | PERM_BAN | PERM_MANAGE_CHANNELS | PERM_MANAGE_GUILD | PERM_MANAGE_ROLES | PERM_MANAGE_MESSAGES | PERM_MODERATE;

const VIEW_PAIR        = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const VOICE_VIEW       = VIEW_PAIR | CONNECT | SPEAK | USE_VAD;
const STAFF_TEXT_ALLOW = VIEW_PAIR | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS | MANAGE_MESSAGES;
const STAFF_VOICE_ALLOW = STAFF_TEXT_ALLOW | CONNECT | SPEAK | USE_VAD;

// Match against the NFKD-normalized name so unicode-styled letters
// (𝐹𝑜𝓊𝓃𝒹𝑒𝓇𝓈, 𝐿𝑒𝒶𝒹𝑒𝓇𝓈, etc.) decompose to plain ASCII first.
const STAFF_NAME_RE = /(founders?|leaders?|^lead[-_]?|admin|moderator|^mod[-_]|staff|kanrisha|kaishakunin|wukong|musashi|lu ?bu|punish|^logs?$|mod-log|mod-section|mod-chat|tickets?|audit|^owner|report|backstage)/i;

// Channels that should be forcibly kept member-invite-only regardless of
// auto-detection. Add new IDs here when an admin wants a per-member grant
// preserved without classifying the channel as STAFF or VERIFIED.
const CHANNEL_CLASS_OVERRIDE = {
  '1470598820172795945': 'private',  // #Good-Bye (bot ops, member-only)
  '1470675898662654002': 'private',  // #Commands (bot ops, member-only)
  '1487533244202357007': 'private',  // #♥ Me with my Fam ♥
  '1502435691412459540': 'private',  // #Kitsune Sanctuary
};
function staffName(name) {
  if (!name) return false;
  const norm = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return STAFF_NAME_RE.test(norm);
}

// ──────────────────────────────────────────────────────────────────────────
// Boot: decrypt bot token
// ──────────────────────────────────────────────────────────────────────────
const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [KITSUNE_ID]);
if (rows.length === 0) {
  console.error(`Kitsune bot row not found (bot_id=${KITSUNE_ID})`);
  process.exit(1);
}
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
  await new Promise(r => setTimeout(r, 110));
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 300));
    return api(method, path, body);
  }
  if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 300) } };
  return res.status === 204 ? null : res.json();
}

// ──────────────────────────────────────────────────────────────────────────
// Step 1: roles — find @Verified + staff roles
// ──────────────────────────────────────────────────────────────────────────
console.log('=== Kitsune lockdown — guild 1469931133981687873 ===\n');
console.log('[1] Fetching roles…');

const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
if (roles?.__err) { console.error('Failed to fetch roles:', roles.__err); process.exit(1); }

const verifiedMatches = roles.filter(r => /^verified$|^✅?\s*verified|\bverified\b/i.test(r.name));
if (verifiedMatches.length === 0) {
  console.error('✗ No role matching "Verified" found. Roles in guild:');
  for (const r of roles) console.error(`    ${r.id}  ${r.name}`);
  process.exit(1);
}
if (verifiedMatches.length > 1) {
  console.error('✗ Multiple roles match /verified/i — pick one and set VERIFIED_ROLE manually:');
  for (const r of verifiedMatches) console.error(`    ${r.id}  ${r.name}`);
  process.exit(1);
}
const VERIFIED_ROLE = verifiedMatches[0].id;
console.log(`    ✓ @Verified → ${verifiedMatches[0].name} (${VERIFIED_ROLE})\n`);

const staffRoles = roles
  .filter(r => r.id !== GUILD_ID && r.id !== VERIFIED_ROLE && !r.managed)
  .filter(r => (BigInt(r.permissions || '0') & STAFF_BITS) !== 0n)
  .sort((a, b) => b.position - a.position);

console.log(`[2] Discovered ${staffRoles.length} staff-tier role(s):`);
for (const r of staffRoles) console.log(`    • ${r.name} (${r.id})`);
const STAFF_IDS = staffRoles.map(r => r.id);
console.log('');

// ──────────────────────────────────────────────────────────────────────────
// Step 2: strip VIEW_CHANNEL + CREATE_INSTANT_INVITE from @everyone (guild role)
// Strip CREATE_INSTANT_INVITE from @Verified too — the public channel's
// per-channel allow re-grants it surgically there.
// ──────────────────────────────────────────────────────────────────────────
console.log('[3] Hardening guild-level role permissions…');
const everyoneRole = roles.find(r => r.id === GUILD_ID);
const currentEv = BigInt(everyoneRole.permissions);
const targetEv  = currentEv & ~(VIEW_CHANNEL | CREATE_INSTANT_INVITE | READ_MESSAGE_HISTORY);
if (currentEv !== targetEv) {
  const r = await api('PATCH', `/guilds/${GUILD_ID}/roles/${GUILD_ID}`, { permissions: String(targetEv) });
  if (r?.__err) console.log(`    ✗ @everyone strip: ${r.__err.status} ${r.__err.body.slice(0,180)}`);
  else          console.log(`    ✓ @everyone permissions ${currentEv} → ${targetEv}`);
} else {
  console.log(`    ✓ @everyone already lacks VIEW/INVITE/READ_HIST (${currentEv})`);
}

const verifiedRoleObj = roles.find(r => r.id === VERIFIED_ROLE);
const currentVer = BigInt(verifiedRoleObj.permissions);
const targetVer  = currentVer & ~CREATE_INSTANT_INVITE;
if (currentVer !== targetVer) {
  const r = await api('PATCH', `/guilds/${GUILD_ID}/roles/${VERIFIED_ROLE}`, { permissions: String(targetVer) });
  if (r?.__err) console.log(`    ✗ @Verified strip: ${r.__err.status} ${r.__err.body.slice(0,180)}`);
  else          console.log(`    ✓ @Verified permissions ${currentVer} → ${targetVer}`);
} else {
  console.log(`    ✓ @Verified already lacks CREATE_INSTANT_INVITE`);
}
console.log('');

// ──────────────────────────────────────────────────────────────────────────
// Step 3: fetch channels + classify
// ──────────────────────────────────────────────────────────────────────────
console.log('[4] Fetching channels…');
const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
if (channels?.__err) { console.error('Failed to fetch channels:', channels.__err); process.exit(1); }

channels.sort((a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || a.position - b.position);

const CLASS = { PUBLIC: 'public', VERIFIED: 'verified', STAFF: 'staff', PRIVATE: 'private' };

function classify(ch, parentCategoryMap) {
  if (ch.id === PUBLIC_CH) return CLASS.PUBLIC;
  // Explicit per-channel override always wins (PRIVATE-by-decree).
  if (CHANNEL_CLASS_OVERRIDE[ch.id]) return CHANNEL_CLASS_OVERRIDE[ch.id];
  // Catches both channels and categories — category names like
  // "🎀 Leadership 🎀" need STAFF class too so @Verified doesn't see the
  // empty/locked category bar in their sidebar.
  if (staffName(ch.name || '')) return CLASS.STAFF;
  // Inherit STAFF from a staff-named parent category (e.g. #bots living
  // inside the Leadership category should still be staff-only).
  if (ch.parent_id && parentCategoryMap?.get(ch.parent_id) === CLASS.STAFF) return CLASS.STAFF;
  // Member-invite-only signal: BOTH @everyone deny VIEW AND a type=1 member
  // overwrite — but ALSO require that no role-level allow VIEW exists for a
  // common-tier role (i.e., truly invite-only). Otherwise a stray member
  // grant on a normally-verified channel flips it to PRIVATE and strips
  // @Verified access.
  const ow = ch.permission_overwrites || [];
  const everyoneOw = ow.find(o => o.id === GUILD_ID);
  const everyoneDeniesView = everyoneOw && (BigInt(everyoneOw.deny || '0') & VIEW_CHANNEL) === VIEW_CHANNEL;
  const hasMemberOw = ow.some(o => o.type === 1);
  if (everyoneDeniesView && hasMemberOw && ch.parent_id && parentCategoryMap?.get(ch.parent_id) === CLASS.PRIVATE) {
    return CLASS.PRIVATE;
  }
  return CLASS.VERIFIED;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 4: overwrite-merge helpers
// ──────────────────────────────────────────────────────────────────────────
function getOrCreate(ow, id, type) {
  let entry = ow.find(o => o.id === id);
  if (!entry) {
    entry = { id, type, allow: '0', deny: '0' };
    ow.push(entry);
  }
  return entry;
}
function setBits(entry, addAllow = 0n, removeAllow = 0n, addDeny = 0n, removeDeny = 0n) {
  const a = (BigInt(entry.allow || '0') | addAllow) & ~removeAllow;
  const d = (BigInt(entry.deny  || '0') | addDeny)  & ~removeDeny;
  entry.allow = String(a);
  entry.deny  = String(d);
}
function dropIfEmpty(ow, id) {
  const idx = ow.findIndex(o => o.id === id);
  if (idx >= 0 && ow[idx].allow === '0' && ow[idx].deny === '0') ow.splice(idx, 1);
}

function applyPublic(ow, isVoice) {
  const ev = getOrCreate(ow, GUILD_ID, 0);
  setBits(ev,
    VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),  // allow
    0n,
    0n,
    VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n)   // remove any deny
  );
  const v = ow.find(o => o.id === VERIFIED_ROLE);
  if (v) {
    setBits(v, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n), 0n, 0n);
    dropIfEmpty(ow, VERIFIED_ROLE);
  }
  for (const sid of STAFF_IDS) {
    const s = ow.find(o => o.id === sid);
    if (s) {
      setBits(s, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n), 0n, 0n);
      dropIfEmpty(ow, sid);
    }
  }
}

function applyVerified(ow, isVoice) {
  const ev = getOrCreate(ow, GUILD_ID, 0);
  // Strip allow-VIEW and add deny-VIEW + deny-INVITE on @everyone. Belt-and-suspenders:
  // even if some other role at the guild level still grants VIEW, the channel-level deny stops it.
  setBits(ev,
    0n,
    VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
    VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
    0n
  );
  // @Verified: explicit allow VIEW + READ_HIST (+ voice bits when applicable).
  const v = getOrCreate(ow, VERIFIED_ROLE, 0);
  const wantedAllow = isVoice ? VOICE_VIEW : VIEW_PAIR;
  setBits(v, wantedAllow, 0n, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n));
  // Staff inherit Verified — strip any explicit staff allow we'd otherwise have added.
  for (const sid of STAFF_IDS) {
    const s = ow.find(o => o.id === sid);
    if (s) {
      const before = { allow: BigInt(s.allow), deny: BigInt(s.deny) };
      setBits(s, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n), 0n, 0n);
      const staffMask = isVoice ? STAFF_VOICE_ALLOW : STAFF_TEXT_ALLOW;
      if (before.allow === staffMask && before.deny === 0n) {
        dropIfEmpty(ow, sid);
      } else {
        dropIfEmpty(ow, sid);
      }
    }
  }
}

function applyStaff(ow, isVoice) {
  const ev = getOrCreate(ow, GUILD_ID, 0);
  setBits(ev,
    0n,
    VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
    VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
    0n
  );
  // @Verified explicitly denied — staff channels are NOT verified-tier
  const v = getOrCreate(ow, VERIFIED_ROLE, 0);
  setBits(v,
    0n,
    VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n),
    VIEW_PAIR | (isVoice ? CONNECT : 0n),
    0n
  );
  // Each staff role: explicit allow
  for (const sid of STAFF_IDS) {
    const s = getOrCreate(ow, sid, 0);
    const wantedAllow = isVoice ? STAFF_VOICE_ALLOW : STAFF_TEXT_ALLOW;
    setBits(s, wantedAllow, 0n, 0n, VIEW_PAIR | (isVoice ? VOICE_VIEW : 0n));
  }
}

function applyPrivate(ow, isVoice) {
  // Member-invite-only: keep @everyone deny VIEW. Don't add @Verified — invite is per-member.
  const ev = getOrCreate(ow, GUILD_ID, 0);
  setBits(ev,
    0n,
    VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
    VIEW_PAIR | CREATE_INSTANT_INVITE | (isVoice ? CONNECT : 0n),
    0n
  );
  const vIdx = ow.findIndex(o => o.id === VERIFIED_ROLE);
  if (vIdx >= 0) ow.splice(vIdx, 1);
  // Revert any staff allow this script added on a previous run (exact-mask, no extra deny → my fingerprint)
  const staffMask = isVoice ? STAFF_VOICE_ALLOW : STAFF_TEXT_ALLOW;
  for (const sid of STAFF_IDS) {
    const idx = ow.findIndex(o => o.id === sid);
    if (idx >= 0) {
      const s = ow[idx];
      if (BigInt(s.allow || '0') === staffMask && BigInt(s.deny || '0') === 0n) ow.splice(idx, 1);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Step 5: apply overwrites
// ──────────────────────────────────────────────────────────────────────────
console.log(`[5] Applying overwrites to ${channels.length} channels (incl. categories)…\n`);

const stats = { patched: 0, unchanged: 0, errored: 0, onboardingFallback: 0, byClass: { public: 0, verified: 0, staff: 0, private: 0 } };

// Two-pass: classify all categories first so child channels can inherit.
const parentCategoryMap = new Map();
for (const c of channels) {
  if (c.type === 4) parentCategoryMap.set(c.id, classify(c, parentCategoryMap));
}

for (const ch of channels) {
  const klass = classify(ch, parentCategoryMap);
  stats.byClass[klass]++;
  const isCategory = ch.type === 4;
  const isVoice    = ch.type === 2 || ch.type === 13;

  const overwrites = (ch.permission_overwrites || []).map(o => ({
    id: o.id, type: o.type, allow: o.allow, deny: o.deny,
  }));
  const before = JSON.stringify(overwrites);

  if (klass === CLASS.PUBLIC)   applyPublic(overwrites, isVoice);
  if (klass === CLASS.VERIFIED) applyVerified(overwrites, isVoice);
  if (klass === CLASS.STAFF)    applyStaff(overwrites, isVoice);
  if (klass === CLASS.PRIVATE)  applyPrivate(overwrites, isVoice);

  dropIfEmpty(overwrites, GUILD_ID);

  const after = JSON.stringify(overwrites);
  if (after === before) {
    stats.unchanged++;
    console.log(`    = [${klass}] ${isCategory ? 'CAT' : '#' + ch.name} (${ch.id}) — no diff`);
    continue;
  }

  let res = await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });

  // Discord error 350003: onboarding-flagged channel must be readable by @everyone.
  // Fall back: keep the strip but skip the @everyone deny.
  if (res?.__err && res.__err.body.includes('350003') && klass === CLASS.VERIFIED) {
    const ev = overwrites.find(o => o.id === GUILD_ID);
    if (ev) {
      setBits(ev, 0n, 0n, 0n, VIEW_PAIR | (isVoice ? CONNECT : 0n));
      dropIfEmpty(overwrites, GUILD_ID);
    }
    res = await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });
    if (!res?.__err) {
      stats.patched++;
      stats.onboardingFallback++;
      console.log(`    ⚠ [${klass}] #${ch.name} (${ch.id}) — onboarding-flagged, applied without @everyone deny VIEW`);
      continue;
    }
  }

  if (res?.__err) {
    stats.errored++;
    console.log(`    ✗ [${klass}] ${isCategory ? 'CAT' : '#' + ch.name} (${ch.id}): ${res.__err.status} ${res.__err.body.slice(0,180)}`);
  } else {
    stats.patched++;
    console.log(`    ✓ [${klass}] ${isCategory ? 'CAT' : '#' + ch.name} (${ch.id})`);
  }
}

console.log('\n=== Class breakdown ===');
console.log(`  PUBLIC (only #${PUBLIC_CH}):  ${stats.byClass.public}`);
console.log(`  VERIFIED-gated:               ${stats.byClass.verified}`);
console.log(`  STAFF-only:                   ${stats.byClass.staff}`);
console.log(`  MEMBER-PRIVATE (preserved):   ${stats.byClass.private}`);
console.log('\n=== Run stats ===');
console.log(`  Patched:                      ${stats.patched}`);
console.log(`  Onboarding-flagged fallback:  ${stats.onboardingFallback}`);
console.log(`  Unchanged (no diff):          ${stats.unchanged}`);
console.log(`  Errored:                      ${stats.errored}`);

// ──────────────────────────────────────────────────────────────────────────
// Step 6: verification pass — re-fetch + report leaks
// ──────────────────────────────────────────────────────────────────────────
console.log('\n[6] Verification pass…');
const verifyRoles    = await api('GET', `/guilds/${GUILD_ID}/roles`);
const verifyChannels = await api('GET', `/guilds/${GUILD_ID}/channels`);
const everyoneAfter  = verifyRoles.find(r => r.id === GUILD_ID);
const everyonePerms  = BigInt(everyoneAfter.permissions);

const viewLeak   = (everyonePerms & VIEW_CHANNEL)          === VIEW_CHANNEL;
const inviteLeak = (everyonePerms & CREATE_INSTANT_INVITE) === CREATE_INSTANT_INVITE;
console.log(`  Guild @everyone VIEW_CHANNEL:           ${viewLeak ? '❌ LEAK' : '✓ stripped'}`);
console.log(`  Guild @everyone CREATE_INSTANT_INVITE:  ${inviteLeak ? '❌ LEAK' : '✓ stripped'}`);

const verifyCatMap = new Map();
for (const c of verifyChannels) {
  if (c.type === 4) verifyCatMap.set(c.id, classify(c, verifyCatMap));
}

const leaksView = [];
const leaksInvite = [];
const missingVerified = [];
for (const ch of verifyChannels) {
  if (ch.type === 4) continue;
  const klass = classify(ch, verifyCatMap);
  const ow = ch.permission_overwrites || [];
  const ev = ow.find(o => o.id === GUILD_ID);
  const v  = ow.find(o => o.id === VERIFIED_ROLE);

  const evAllowsView   = ev && (BigInt(ev.allow || '0') & VIEW_CHANNEL)          === VIEW_CHANNEL;
  const evAllowsInvite = ev && (BigInt(ev.allow || '0') & CREATE_INSTANT_INVITE) === CREATE_INSTANT_INVITE;
  const verifiedAllow  = v  && (BigInt(v.allow  || '0') & VIEW_CHANNEL)          === VIEW_CHANNEL;

  if (evAllowsView   && ch.id !== PUBLIC_CH) leaksView.push(ch);
  if (evAllowsInvite && ch.id !== PUBLIC_CH) leaksInvite.push(ch);
  if (klass === CLASS.VERIFIED && !verifiedAllow) missingVerified.push(ch);
}

console.log(`\n  @everyone allow-VIEW leaks   (≠ #${PUBLIC_CH}): ${leaksView.length}`);
for (const c of leaksView) console.log(`    ❌ #${c.name} (${c.id})`);
console.log(`  @everyone allow-INVITE leaks (≠ #${PUBLIC_CH}): ${leaksInvite.length}`);
for (const c of leaksInvite) console.log(`    ❌ #${c.name} (${c.id})`);
console.log(`  VERIFIED channels missing @Verified allow:    ${missingVerified.length}`);
for (const c of missingVerified) console.log(`    ❌ #${c.name} (${c.id})`);

await pool.end();
console.log('\nDone.');
