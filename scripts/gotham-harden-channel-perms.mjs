// Apply a consistent Citizen-default + staff-exception permission policy to
// every channel + category in The Bat Cave.
//
// Classes:
//   PUBLIC  — @everyone CAN view (rules, welcome only)
//   CITIZEN — @everyone CANNOT view; Gotham Citizen explicitly allowed
//   STAFF   — @everyone CANNOT view; Gotham Citizen explicitly DENIED; all
//             human-staff roles explicitly allowed.
//
// All non-category channels also receive a Muted deny mask
// (SEND_MESSAGES | SPEAK | ADD_REACTIONS).
//
// Preserves type=1 (member) overwrites — those are ticket-manager.js's
// per-user grants. Only touches role overwrites we own.
//
// REST-only via Harley's Bat token. Safe alongside live PM2.

import 'dotenv/config';
import fs from 'fs/promises';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '800157336458231848';
const HARLEY_BOT_ID = '1503936879635202149';

const CITIZEN_ROLE = '800252381513777158';
const MUTED_ROLE   = '1503946366542548992';

// ──────────────────────────────────────────────────────────────────────────
// Permission bits
// ──────────────────────────────────────────────────────────────────────────
const VIEW_CHANNEL          = 1n << 10n;  // 1024
const SEND_MESSAGES         = 1n << 11n;  // 2048
const READ_MESSAGE_HISTORY  = 1n << 16n;  // 65536
const ADD_REACTIONS         = 1n << 6n;   // 64
const EMBED_LINKS           = 1n << 14n;  // 16384
const ATTACH_FILES          = 1n << 15n;  // 32768
const USE_EXTERNAL_EMOJIS   = 1n << 18n;  // 262144
const MANAGE_MESSAGES       = 1n << 13n;  // 8192
const MANAGE_CHANNELS       = 1n << 4n;   // 16
const CONNECT               = 1n << 20n;  // 1048576
const SPEAK                 = 1n << 21n;  // 2097152
const USE_VAD               = 1n << 25n;  // 33554432

const VIEW_BITS         = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const VOICE_BITS        = CONNECT | SPEAK | USE_VAD;
const MUTED_DENY_MASK   = SEND_MESSAGES | SPEAK | ADD_REACTIONS;          // 2097216
const STAFF_ALLOW_TEXT  = VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS | MANAGE_MESSAGES;
const STAFF_ALLOW_VOICE = STAFF_ALLOW_TEXT | CONNECT | SPEAK | USE_VAD;
const CITIZEN_ALLOW_TEXT  = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const CITIZEN_ALLOW_VOICE = VIEW_CHANNEL | READ_MESSAGE_HISTORY | CONNECT | SPEAK | USE_VAD;
const PUBLIC_ALLOW        = VIEW_CHANNEL | READ_MESSAGE_HISTORY;

// ──────────────────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────────────────
const CLASS = { PUBLIC: 'public', CITIZEN: 'citizen', STAFF: 'staff', PRIVATE: 'private' };

const CATEGORY_CLASS = {
  '1070157474331623484': CLASS.CITIZEN,  // 🦇 Welcome to The Bat Cave! 🦇 (default citizen, public exceptions override)
  '800157336983044166':  CLASS.CITIZEN,  // ♦Gotham Citizens Hangout♦
  '1034678159418851428': CLASS.CITIZEN,  // 💖 Other Important Channels 💖
  '800182693945409546':  CLASS.STAFF,    // 🃏Channel Updates & Mod Rules🃏
  '1070184347178631229': CLASS.CITIZEN,  // 🎤 Gotham Citizens Chat Rooms 🎤
  '1503938673035710568': CLASS.STAFF,    // 🎫 Tickets
};

const CHANNEL_CLASS_OVERRIDE = {
  '800256456997863434':  CLASS.PUBLIC,   // #gcpd-handbook-of-rules
  '1503938671857106955': CLASS.PUBLIC,   // #welcome
  '1466492477400809493': CLASS.STAFF,    // #mod-chat
  '1503938669294125126': CLASS.STAFF,    // #server-logs
  '800183363188162620':  CLASS.STAFF,    // #channel-updates🔔
  '1385526763861442610': CLASS.PRIVATE,  // #Ultra Secret VC — member-invite-only
  '800157336983044169':  CLASS.PRIVATE,  // #The Bat Hideout (VC for Streaming) — member-invite-only
};

const NAME_PATTERN_STAFF = /^(mod[-_]|admin[-_]|staff[-_]|gcpd[-_]|punishment|^logs?$|^tickets?$|^mod[-_]?chat$|^server[-_]?logs?$)/i;

function classifyChannel(ch) {
  // 1. Explicit per-channel override always wins
  if (CHANNEL_CLASS_OVERRIDE[ch.id]) return CHANNEL_CLASS_OVERRIDE[ch.id];
  // 2. Name-pattern match for staff-style channels
  if (NAME_PATTERN_STAFF.test(ch.name || '')) return CLASS.STAFF;
  // 3. The category itself, if classified
  if (ch.type === 4 && CATEGORY_CLASS[ch.id]) return CATEGORY_CLASS[ch.id];
  // 4. Channel's parent category, if classified
  if (CATEGORY_CLASS[ch.parent_id]) return CATEGORY_CLASS[ch.parent_id];
  // 5. Auto-detect member-invite-only (only fires when nothing above matched)
  const ow = ch.permission_overwrites || [];
  const everyoneOw = ow.find(o => o.id === GUILD);
  const everyoneDeniesView = everyoneOw && (BigInt(everyoneOw.deny || '0') & VIEW_CHANNEL) === VIEW_CHANNEL;
  const hasMemberOw = ow.some(o => o.type === 1);
  if (everyoneDeniesView && hasMemberOw) return CLASS.PRIVATE;
  return CLASS.CITIZEN;
}

// ──────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────
const [row] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [HARLEY_BOT_ID]);
const token = encryption.decrypt(JSON.parse(row[0].bot_token));

const staffRolesJson = JSON.parse(await fs.readFile('docs/gotham-staff-roles.json', 'utf8'));
const HUMAN_STAFF_ROLE_IDS = staffRolesJson.humanStaff.map(r => r.id);
console.log(`Loaded ${HUMAN_STAFF_ROLE_IDS.length} human-staff role(s):`);
for (const r of staffRolesJson.humanStaff) console.log(`  • ${r.name} (${r.id})`);
console.log('');

async function api(method, path, body) {
  await new Promise(r => setTimeout(r, 100));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 300));
    return api(method, path, body);
  }
  if (!r.ok) return { __err: { status: r.status, body: (await r.text()).slice(0, 250) } };
  return r.status === 204 ? null : r.json();
}

// ──────────────────────────────────────────────────────────────────────────
// Overwrite-merge helpers — always preserve unrelated bits
// ──────────────────────────────────────────────────────────────────────────
function getOrCreate(overwrites, id, type) {
  let ow = overwrites.find(o => o.id === id);
  if (!ow) {
    ow = { id, type, allow: '0', deny: '0' };
    overwrites.push(ow);
  }
  return ow;
}

function setBits(ow, allowAdd = 0n, allowRemove = 0n, denyAdd = 0n, denyRemove = 0n) {
  const a = (BigInt(ow.allow || '0') | allowAdd) & ~allowRemove;
  const d = (BigInt(ow.deny  || '0') | denyAdd)  & ~denyRemove;
  ow.allow = String(a);
  ow.deny  = String(d);
}

function dropIfEmpty(overwrites, id) {
  const idx = overwrites.findIndex(o => o.id === id);
  if (idx >= 0 && overwrites[idx].allow === '0' && overwrites[idx].deny === '0') {
    overwrites.splice(idx, 1);
  }
}

function ensureMuted(overwrites /*, isVoice */) {
  const ow = getOrCreate(overwrites, MUTED_ROLE, 0);
  // Apply the full mask (SEND | SPEAK | ADD_REACTIONS) universally — Discord
  // ignores SPEAK on text channels, so this is a no-op cost but keeps the
  // audit's expected-mask check trivially true.
  setBits(ow, 0n, 0n, MUTED_DENY_MASK, 0n);
}

function applyPublic(overwrites, isVoice) {
  const ev = getOrCreate(overwrites, GUILD, 0);
  setBits(ev, PUBLIC_ALLOW | (isVoice ? CONNECT : 0n), 0n, 0n, VIEW_BITS);
  // Drop any explicit Citizen deny we might have set previously
  const ci = overwrites.find(o => o.id === CITIZEN_ROLE);
  if (ci) {
    setBits(ci, 0n, 0n, 0n, VIEW_BITS);
    dropIfEmpty(overwrites, CITIZEN_ROLE);
  }
  // Staff roles inherit public — drop any allow we added (cleanup)
  for (const sid of HUMAN_STAFF_ROLE_IDS) {
    const s = overwrites.find(o => o.id === sid);
    if (s) {
      setBits(s, 0n, VIEW_BITS, 0n, 0n);
      dropIfEmpty(overwrites, sid);
    }
  }
}

function applyCitizen(overwrites, isVoice) {
  // @everyone: strip allow VIEW + add deny VIEW. The deny ensures NO role-level
  // VIEW grant (Server Booster, Batman's Tech Bots, etc.) leaks visibility.
  // The deny is then surgically re-allowed only by the Citizen overwrite below.
  const ev = getOrCreate(overwrites, GUILD, 0);
  setBits(ev, 0n, VIEW_BITS | (isVoice ? CONNECT : 0n), VIEW_BITS | (isVoice ? CONNECT : 0n), 0n);
  // Gotham Citizen: explicit allow VIEW (+ voice bits for voice channels).
  const ci = getOrCreate(overwrites, CITIZEN_ROLE, 0);
  const wanted = isVoice ? CITIZEN_ALLOW_VOICE : CITIZEN_ALLOW_TEXT;
  setBits(ci, wanted, 0n, 0n, VIEW_BITS | (isVoice ? VOICE_BITS : 0n));
  // Staff roles inherit Citizen — drop any explicit grant
  for (const sid of HUMAN_STAFF_ROLE_IDS) {
    const s = overwrites.find(o => o.id === sid);
    if (s) {
      setBits(s, 0n, VIEW_BITS | (isVoice ? VOICE_BITS : 0n), 0n, 0n);
      dropIfEmpty(overwrites, sid);
    }
  }
}

function applyStaff(overwrites, isVoice) {
  // @everyone: deny VIEW. Also drop any stale allow.
  const ev = getOrCreate(overwrites, GUILD, 0);
  setBits(ev, 0n, VIEW_BITS | (isVoice ? CONNECT : 0n), VIEW_BITS, 0n);
  // Gotham Citizen: explicit deny VIEW (and voice).
  const ci = getOrCreate(overwrites, CITIZEN_ROLE, 0);
  setBits(ci, 0n, VIEW_BITS | (isVoice ? VOICE_BITS : 0n), VIEW_BITS | (isVoice ? CONNECT : 0n), 0n);
  // Each human-staff role: explicit allow.
  for (const sid of HUMAN_STAFF_ROLE_IDS) {
    const s = getOrCreate(overwrites, sid, 0);
    const wanted = isVoice ? STAFF_ALLOW_VOICE : STAFF_ALLOW_TEXT;
    setBits(s, wanted, 0n, 0n, VIEW_BITS | (isVoice ? VOICE_BITS : 0n));
  }
}

function applyPrivate(overwrites, isVoice) {
  // @everyone: ensure deny VIEW + READ_HIST (+ CONNECT for voice). Preserve unrelated denies.
  const ev = getOrCreate(overwrites, GUILD, 0);
  setBits(ev, 0n, VIEW_BITS | (isVoice ? CONNECT : 0n), VIEW_BITS | (isVoice ? CONNECT : 0n), 0n);
  // Citizen: remove any overwrite — invite-only channels grant access per-member, not per-role
  const ci = overwrites.findIndex(o => o.id === CITIZEN_ROLE);
  if (ci >= 0) overwrites.splice(ci, 1);
  // Revert ANY staff overwrite added by a previous harden run. Signature: allow
  // exactly equals my STAFF_ALLOW mask AND deny=0. Pre-existing role overwrites
  // (e.g. Husband on Ultra Secret VC = 7709915186986560, or Gotham Knights with
  // a non-zero deny) won't match this exact shape, so they're preserved.
  const staffMask = isVoice ? STAFF_ALLOW_VOICE : STAFF_ALLOW_TEXT;
  for (const sid of HUMAN_STAFF_ROLE_IDS) {
    const idx = overwrites.findIndex(o => o.id === sid);
    if (idx >= 0) {
      const ow = overwrites[idx];
      if (BigInt(ow.allow || '0') === staffMask && BigInt(ow.deny || '0') === 0n) {
        overwrites.splice(idx, 1);
      }
    }
  }
}

function applyClass(overwrites, klass, isVoice) {
  if (klass === CLASS.PUBLIC)  applyPublic(overwrites, isVoice);
  if (klass === CLASS.CITIZEN) applyCitizen(overwrites, isVoice);
  if (klass === CLASS.STAFF)   applyStaff(overwrites, isVoice);
  if (klass === CLASS.PRIVATE) applyPrivate(overwrites, isVoice);
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
console.log('=== Bat Cave channel-permission hardening ===\n');

// 2a. Re-assert guild-level @everyone permissions (idempotent VIEW removal)
console.log('[1] Re-asserting @everyone guild-level role permissions…');
const roles = await api('GET', `/guilds/${GUILD}/roles`);
const everyoneRole = roles.find(r => r.id === GUILD);
const currentEveryone = BigInt(everyoneRole.permissions);
const newEveryone = currentEveryone & ~(VIEW_CHANNEL | READ_MESSAGE_HISTORY | CONNECT | SPEAK);
if (currentEveryone !== newEveryone) {
  const r = await api('PATCH', `/guilds/${GUILD}/roles/${GUILD}`, { permissions: String(newEveryone) });
  if (r?.__err) console.log(`    ✗ ${r.__err.status} ${r.__err.body.slice(0,150)}`);
  else console.log(`    ✓ @everyone perms ${currentEveryone} → ${newEveryone}`);
} else {
  console.log(`    ✓ @everyone perms already correct (${currentEveryone})`);
}

// 2a-bis: Ensure Gotham Citizen has baseline view-level guild perms (durability)
const citizenRole = roles.find(r => r.id === CITIZEN_ROLE);
const currentCitizen = BigInt(citizenRole.permissions);
const baselineCitizen = currentCitizen | VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS | ADD_REACTIONS | CONNECT | SPEAK | USE_VAD;
if (currentCitizen !== baselineCitizen) {
  const r = await api('PATCH', `/guilds/${GUILD}/roles/${CITIZEN_ROLE}`, { permissions: String(baselineCitizen) });
  if (r?.__err) console.log(`    ✗ Citizen baseline grant: ${r.__err.status} ${r.__err.body.slice(0,150)}`);
  else console.log(`    ✓ Gotham Citizen perms ${currentCitizen} → ${baselineCitizen}`);
} else {
  console.log(`    ✓ Gotham Citizen perms already include baseline (${currentCitizen})`);
}

// 2b. Apply class-specific overwrites to all channels (and categories)
console.log('\n[2] Applying class-specific overwrites…');
const channels = await api('GET', `/guilds/${GUILD}/channels`);

// Sort: categories first (so children that inherit see fresh parent), then by position
channels.sort((a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || a.position - b.position);

const stats = { patched: 0, unchanged: 0, errored: 0, byClass: { public: 0, citizen: 0, staff: 0, private: 0 } };

for (const ch of channels) {
  const klass = classifyChannel(ch);
  stats.byClass[klass]++;
  const isCategory = ch.type === 4;
  const isVoice    = ch.type === 2 || ch.type === 13;

  // Copy existing overwrites (preserve type=1 member overwrites verbatim)
  const overwrites = (ch.permission_overwrites || []).map(o => ({
    id: o.id, type: o.type, allow: o.allow, deny: o.deny,
  }));

  // Snapshot before for change detection
  const before = JSON.stringify(overwrites);

  // Apply class-specific role overwrites
  applyClass(overwrites, klass, isVoice);

  // Always apply Muted deny on non-categories
  if (!isCategory) ensureMuted(overwrites, isVoice);

  const after = JSON.stringify(overwrites);
  if (after === before) {
    stats.unchanged++;
    continue;
  }

  let r = await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });

  // Discord error 350003 ("Onboarding channels must be readable by everyone")
  // hits a handful of community-flagged channels (system_channel, etc.).
  // Fall back: strip the @everyone deny VIEW/READ_HIST/CONNECT we added and
  // retry. Citizen-only access still holds via guild-level @everyone no-VIEW
  // for any user who lacks a role with guild-level VIEW.
  if (r?.__err && r.__err.body.includes('350003') && klass === CLASS.CITIZEN) {
    const ev = overwrites.find(o => o.id === GUILD);
    if (ev) {
      setBits(ev, 0n, 0n, 0n, VIEW_BITS | (isVoice ? CONNECT : 0n));
      dropIfEmpty(overwrites, GUILD);
    }
    r = await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });
    if (!r?.__err) {
      stats.patched++;
      console.log(`    ⚠ [${klass}] #${ch.name} (${ch.id}): onboarding-flagged — applied without @everyone deny VIEW`);
      continue;
    }
  }

  if (r?.__err) {
    stats.errored++;
    console.log(`    ✗ [${klass}] ${isCategory ? 'CATEGORY' : '#' + ch.name} (${ch.id}): ${r.__err.status} ${r.__err.body.slice(0,150)}`);
  } else {
    stats.patched++;
    console.log(`    ✓ [${klass}] ${isCategory ? 'CATEGORY' : '#' + ch.name} (${ch.id})`);
  }
}

console.log('\n=== Summary ===');
console.log(`Total channels:       ${channels.length}`);
console.log(`  PUBLIC:             ${stats.byClass.public}`);
console.log(`  CITIZEN:            ${stats.byClass.citizen}`);
console.log(`  STAFF-ONLY:         ${stats.byClass.staff}`);
console.log(`  MEMBER-PRIVATE:     ${stats.byClass.private}`);
console.log(`Patched:              ${stats.patched}`);
console.log(`Unchanged (no diff):  ${stats.unchanged}`);
console.log(`Errored:              ${stats.errored}`);

await pool.end();
console.log('\nDone.');
