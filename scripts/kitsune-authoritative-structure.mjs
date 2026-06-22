// Kitsune guild — apply authoritative role + channel structure declared by owner.
// REST-only ops. Safe alongside live PM2 (gateway not used).
// Idempotent: every phase guards before mutating; re-running is safe.
//
// Phase 1: role permission alignment      (PATCH /guilds/{g}/roles/{r})
// Phase 2: delete Kanrisha role            (strip from members, then DELETE)
// Phase 3: member role sync                (PUT /guilds/{g}/members/{u}/roles/{r})
// Phase 4: channel permission overwrites   (PUT /channels/{c}/permissions/{id})
// Phase 5: create about-certifried channel + post banner + pin
// Phase 6: verification — re-fetch + assert

import 'dotenv/config';
import { buildAboutEmbed } from './lib/about-embed.mjs';
import fs from 'fs';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1469931133981687873';
const BOT_ID   = '1498486251576229958';

// ── role IDs (from audit) ────────────────────────────────────────────────
const ROLE = {
  KITSUNE:     '1470260643998208101', // 🎀 Kitsune 🎀 (Owner)
  SUN_WUKONG:  '1469932798638035197', // Founders
  KANRISHA:    '1492565209536270520', // legacy — DELETE
  LU_BU:       '1470108472325570690', // Head Admin
  KAISHAKUNIN: '1470860854009401366', // Co Head
  MUSASHI:     '1469932629003468917', // Co-Owners
  ITTO:        '1470666282280943740', // Mods tier 1
  SANTO:       '1470665850112446546', // Mods tier 2
  VERIFIED:    '1498502484912635906', // baseline access role
};

// ── permission bits (BigInt) ──────────────────────────────────────────────
const BIT = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS:          1n << 1n,
  BAN_MEMBERS:           1n << 2n,
  ADMINISTRATOR:         1n << 3n,
  MANAGE_CHANNELS:       1n << 4n,
  ADD_REACTIONS:         1n << 6n,
  VIEW_CHANNEL:          1n << 10n,
  SEND_MESSAGES:         1n << 11n,
  MANAGE_MESSAGES:       1n << 13n,
  EMBED_LINKS:           1n << 14n,
  ATTACH_FILES:          1n << 15n,
  READ_MESSAGE_HISTORY:  1n << 16n,
  USE_EXTERNAL_EMOJIS:   1n << 18n,
  CONNECT:               1n << 20n,
  SPEAK:                 1n << 21n,
  MOVE_MEMBERS:          1n << 24n,
};

const ROLE_PERMS = {
  // KITSUNE — leave as-is (already Admin + bonus bits)
  [ROLE.SUN_WUKONG]:  BIT.ADMINISTRATOR,
  [ROLE.LU_BU]:       BIT.ADMINISTRATOR,
  [ROLE.KAISHAKUNIN]: BIT.ADMINISTRATOR,
  [ROLE.MUSASHI]:
      BIT.CREATE_INSTANT_INVITE | BIT.KICK_MEMBERS | BIT.BAN_MEMBERS
    | BIT.MANAGE_CHANNELS | BIT.MANAGE_MESSAGES | BIT.MOVE_MEMBERS
    | BIT.VIEW_CHANNEL | BIT.READ_MESSAGE_HISTORY | BIT.SEND_MESSAGES
    | BIT.EMBED_LINKS | BIT.ATTACH_FILES | BIT.USE_EXTERNAL_EMOJIS
    | BIT.ADD_REACTIONS,
  [ROLE.ITTO]:
      BIT.CREATE_INSTANT_INVITE | BIT.KICK_MEMBERS | BIT.BAN_MEMBERS
    | BIT.MANAGE_MESSAGES | BIT.VIEW_CHANNEL | BIT.READ_MESSAGE_HISTORY
    | BIT.SEND_MESSAGES | BIT.EMBED_LINKS | BIT.ATTACH_FILES
    | BIT.USE_EXTERNAL_EMOJIS | BIT.ADD_REACTIONS,
  [ROLE.SANTO]:
      BIT.CREATE_INSTANT_INVITE | BIT.KICK_MEMBERS | BIT.BAN_MEMBERS
    | BIT.MANAGE_MESSAGES | BIT.VIEW_CHANNEL | BIT.READ_MESSAGE_HISTORY
    | BIT.SEND_MESSAGES | BIT.EMBED_LINKS | BIT.ATTACH_FILES
    | BIT.USE_EXTERNAL_EMOJIS | BIT.ADD_REACTIONS,
};

const MEMBER_ROLES = [
  { uid: '533297810309906444',  role: ROLE.KITSUNE,    note: 'Kitsune (Owner)' },
  { uid: '316037348733353984',  role: ROLE.SUN_WUKONG, note: 'Sun Wukong (Founder)' },
  { uid: '365905620060340224',  role: ROLE.LU_BU,      note: 'Lü bu (Head Admin)' },
  { uid: '1089432531641831474', role: ROLE.MUSASHI,    note: 'Miyamoto Musashi (Co-Owner)' },
  { uid: '1326803672679579669', role: ROLE.MUSASHI,    note: 'Miyamoto Musashi (Co-Owner)' },
  { uid: '817782486507454504',  role: ROLE.ITTO,       note: 'Itto Rikui (Mod) — known absent' },
  { uid: '477972657384718336',  role: ROLE.ITTO,       note: 'Itto Rikui (Mod)' },
  { uid: '684441860747427872',  role: ROLE.ITTO,       note: 'Itto Rikui (Mod)' },
  { uid: '1339054976663818333', role: ROLE.SANTO,      note: 'Santo Rikuso (Mod)' },
];

// channel pattern helpers
const VERIFIED_VIEW_ALLOW = BIT.VIEW_CHANNEL | BIT.READ_MESSAGE_HISTORY;
const VERIFIED_TEXT_ALLOW = VERIFIED_VIEW_ALLOW | BIT.SEND_MESSAGES | BIT.EMBED_LINKS
                          | BIT.ATTACH_FILES | BIT.USE_EXTERNAL_EMOJIS | BIT.ADD_REACTIONS;
const POSTER_SEND_ALLOW   = BIT.VIEW_CHANNEL | BIT.READ_MESSAGE_HISTORY
                          | BIT.SEND_MESSAGES | BIT.EMBED_LINKS | BIT.ATTACH_FILES
                          | BIT.USE_EXTERNAL_EMOJIS | BIT.ADD_REACTIONS;
const EVERYONE_DENY       = BIT.VIEW_CHANNEL | BIT.CREATE_INSTANT_INVITE;

// readers:
//   'verified-view-only'   → verified sees but cannot SEND (poster roles override)
//   'verified-text-send'   → verified can SEND
const CHANNELS = [
  { id: '1486042994103812218', name: 'Im-Live (owner)',     readers: 'verified-view-only', posters: [ROLE.KITSUNE] },
  { id: '1470671744946933873', name: 'Founders-Streams',    readers: 'verified-view-only', posters: [ROLE.KITSUNE, ROLE.SUN_WUKONG] },
  { id: '1491131042348929044', name: 'Love-our-Mods',       readers: 'verified-view-only', posters: [ROLE.MUSASHI, ROLE.ITTO, ROLE.SANTO] },
  { id: '1470107240265683006', name: 'VIPs',                readers: 'verified-view-only', posters: [ROLE.MUSASHI, ROLE.ITTO, ROLE.SANTO] },
  { id: '1470600196131000340', name: 'Self-Promo (manual)', readers: 'verified-view-only', posters: [ROLE.KITSUNE, ROLE.SUN_WUKONG] },
  { id: '1486040873186889870', name: 'Reaching-Affiliates', readers: 'verified-text-send' },
  { id: '1482986949751869473', name: 'Collab-Requests',     readers: 'verified-text-send' },
  { id: '1470107305013149806', name: 'Appreciation',        readers: 'verified-text-send' },
  { id: '1470903113685925919', name: 'Social Media (cat)',  readers: 'verified-view-only', posters: [ROLE.MUSASHI, ROLE.ITTO, ROLE.SANTO] },
];

const SANCTUARY_ID   = '1502435691412459540';
const OWNER_UID      = '533297810309906444';
const SUPPORT_CAT_ID = '1499187949625938040';
const BANNER_PATH    = '/home/death/CertiFriedUtility/dashboard/public/images/certifried-banner.png';

// ── token + REST helpers ─────────────────────────────────────────────────
let _token;
async function token() {
  if (_token) return _token;
  const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
  if (!rows.length) throw new Error('Kitsune bot row missing in custom_bots');
  _token = encryption.decrypt(JSON.parse(rows[0].bot_token));
  return _token;
}

async function api(method, path, body) {
  const tk = await token();
  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = { Authorization: 'Bot ' + tk };
    if (body) headers['Content-Type'] = 'application/json';
    const init = { method, headers };
    if (body) init.body = JSON.stringify(body);
    const r = await fetch(`https://discord.com/api/v10${path}`, init);
    if (r.status === 429) {
      const b = await r.json().catch(() => ({ retry_after: 1 }));
      await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 150));
      continue;
    }
    if (r.status === 404) return { __notfound: true };
    if (r.status === 204) return { __ok: true };
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`${r.status} ${method} ${path}: ${t.slice(0, 300)}`);
    }
    return r.json();
  }
  throw new Error(`exhausted retries: ${method} ${path}`);
}

function bitNames(value) {
  const out = [];
  for (const [n, v] of Object.entries(BIT)) if ((value & v) === v) out.push(n);
  return out.join(' | ') || '(none)';
}

async function putOverwrite(channelId, overwriteId, type, allow, deny) {
  await api('PUT', `/channels/${channelId}/permissions/${overwriteId}`, {
    type, allow: allow.toString(), deny: deny.toString(),
  });
}

// ── Phase 1: role permission alignment ───────────────────────────────────
async function phase1_rolePerms() {
  console.log('\n═══ Phase 1: Role permission alignment ═══');
  const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
  let patched = 0, unchanged = 0, missing = 0;
  for (const [rid, target] of Object.entries(ROLE_PERMS)) {
    const role = roles.find(r => r.id === rid);
    if (!role) { console.log(`  ! role ${rid} missing — SKIP`); missing++; continue; }
    const cur = BigInt(role.permissions);
    if (cur === target) {
      console.log(`  ✓ ${role.name} unchanged (${bitNames(cur)})`);
      unchanged++; continue;
    }
    console.log(`  → ${role.name} (${rid})`);
    console.log(`      cur:    ${bitNames(cur)}`);
    console.log(`      target: ${bitNames(target)}`);
    await api('PATCH', `/guilds/${GUILD_ID}/roles/${rid}`, { permissions: target.toString() });
    patched++;
  }
  console.log(`  Phase 1 done: ${patched} patched, ${unchanged} unchanged, ${missing} missing`);
}

// ── Phase 2: delete Kanrisha role ────────────────────────────────────────
async function phase2_killKanrisha() {
  console.log('\n═══ Phase 2: Delete Kanrisha role ═══');
  const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);
  const kRole = roles.find(r => r.id === ROLE.KANRISHA);
  if (!kRole) {
    console.log('  ✓ Kanrisha already absent — nothing to do');
    return;
  }
  // List members; filter to those holding Kanrisha.
  const members = await api('GET', `/guilds/${GUILD_ID}/members?limit=1000`);
  if (!Array.isArray(members)) {
    console.log('  ! could not list members; cannot strip role holders');
    throw new Error('GET members returned non-array');
  }
  const holders = members.filter(m => Array.isArray(m.roles) && m.roles.includes(ROLE.KANRISHA));
  console.log(`  ${holders.length} member(s) currently hold Kanrisha`);
  for (const m of holders) {
    const uid = m.user.id;
    await api('DELETE', `/guilds/${GUILD_ID}/members/${uid}/roles/${ROLE.KANRISHA}`);
    console.log(`  ✓ stripped Kanrisha from ${m.user.username} (${uid})`);
  }
  // Delete the role itself.
  const result = await api('DELETE', `/guilds/${GUILD_ID}/roles/${ROLE.KANRISHA}`);
  if (result?.__ok || result?.__notfound) {
    console.log(`  ✓ Kanrisha role deleted`);
  } else {
    console.log(`  ? unexpected delete response:`, result);
  }
}

// ── Phase 3: member role sync ────────────────────────────────────────────
async function phase3_memberSync() {
  console.log('\n═══ Phase 3: Member role sync ═══');
  let added = 0, already = 0, missing = 0;
  for (const m of MEMBER_ROLES) {
    const member = await api('GET', `/guilds/${GUILD_ID}/members/${m.uid}`);
    if (member?.__notfound) {
      console.log(`  ✗ ${m.uid} NOT IN GUILD — skip (intended: ${m.note})`);
      missing++; continue;
    }
    const username = member.user?.username || m.uid;
    if (Array.isArray(member.roles) && member.roles.includes(m.role)) {
      console.log(`  ✓ ${username} already has ${m.note}`);
      already++; continue;
    }
    await api('PUT', `/guilds/${GUILD_ID}/members/${m.uid}/roles/${m.role}`);
    console.log(`  + ${username} ← ${m.note}`);
    added++;
  }
  console.log(`  Phase 3 done: ${added} added, ${already} already correct, ${missing} skipped (absent)`);
}

// ── Phase 4: channel permission overwrites ──────────────────────────────
async function phase4_channelOverwrites() {
  console.log('\n═══ Phase 4: Channel permission overwrites ═══');
  for (const ch of CHANNELS) {
    console.log(`  · ${ch.name} (${ch.id})  [readers=${ch.readers}, posters=${(ch.posters || []).length}]`);
    // @everyone — deny VIEW + deny invite-create
    await putOverwrite(ch.id, GUILD_ID, 0, 0n, EVERYONE_DENY);
    // @Verified — view-only or text-send
    if (ch.readers === 'verified-view-only') {
      await putOverwrite(ch.id, ROLE.VERIFIED, 0, VERIFIED_VIEW_ALLOW, BIT.SEND_MESSAGES);
    } else if (ch.readers === 'verified-text-send') {
      await putOverwrite(ch.id, ROLE.VERIFIED, 0, VERIFIED_TEXT_ALLOW, 0n);
    }
    // Poster role allows (override the @Verified deny SEND)
    for (const rid of (ch.posters || [])) {
      await putOverwrite(ch.id, rid, 0, POSTER_SEND_ALLOW, 0n);
    }
  }

  // Sanctuary — owner-only voice room
  console.log(`  · Sanctuary (${SANCTUARY_ID}) — owner-only voice`);
  await putOverwrite(SANCTUARY_ID, GUILD_ID, 0, 0n, BIT.VIEW_CHANNEL | BIT.CONNECT);
  await putOverwrite(SANCTUARY_ID, ROLE.VERIFIED, 0, 0n, BIT.VIEW_CHANNEL | BIT.CONNECT);
  await putOverwrite(SANCTUARY_ID, OWNER_UID, 1,
    BIT.VIEW_CHANNEL | BIT.CONNECT | BIT.SPEAK | BIT.MOVE_MEMBERS | BIT.READ_MESSAGE_HISTORY, 0n);

  console.log(`  Phase 4 done: ${CHANNELS.length + 1} channel(s) updated`);
}

// ── Phase 5: about-certifried channel ────────────────────────────────────
function buildInfoEmbed() {
  return buildAboutEmbed();
}

async function phase5_aboutCertifried() {
  console.log('\n═══ Phase 5: Create about-certifried channel ═══');
  const channels = await api('GET', `/guilds/${GUILD_ID}/channels`);
  let ch = channels.find(c => c.type === 0 && c.parent_id === SUPPORT_CAT_ID
                              && /about.?certifried/i.test(c.name));
  if (ch) {
    console.log(`  Existing channel: #${ch.name} (${ch.id})`);
    // Re-assert permissions on existing channel
    await putOverwrite(ch.id, GUILD_ID, 0, 0n, EVERYONE_DENY);
    await putOverwrite(ch.id, ROLE.VERIFIED, 0, VERIFIED_VIEW_ALLOW, BIT.SEND_MESSAGES);
  } else {
    ch = await api('POST', `/guilds/${GUILD_ID}/channels`, {
      name: 'about-certifried',
      type: 0,
      parent_id: SUPPORT_CAT_ID,
      permission_overwrites: [
        { id: GUILD_ID, type: 0, allow: '0', deny: EVERYONE_DENY.toString() },
        { id: ROLE.VERIFIED, type: 0, allow: VERIFIED_VIEW_ALLOW.toString(), deny: BIT.SEND_MESSAGES.toString() },
      ],
    });
    console.log(`  ✓ created #${ch.name} (${ch.id})`);
  }

  const pins = await api('GET', `/channels/${ch.id}/pins`);
  const pinned = Array.isArray(pins) ? pins : [];
  const hasBanner = pinned.some(m => (m.attachments || []).some(a => a.filename === 'certifried-banner.png'));
  const hasEmbed  = pinned.some(m => (m.embeds || []).some(e => e.title === 'About CertiFried'));

  if (!hasBanner) {
    if (!fs.existsSync(BANNER_PATH)) throw new Error(`banner missing at ${BANNER_PATH}`);
    const buf = fs.readFileSync(BANNER_PATH);
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({}));
    fd.append('files[0]', new Blob([buf], { type: 'image/png' }), 'certifried-banner.png');
    const tk = await token();
    const r = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
      method: 'POST', headers: { Authorization: 'Bot ' + tk }, body: fd,
    });
    if (!r.ok) throw new Error(`banner post: ${r.status} ${(await r.text()).slice(0, 300)}`);
    const msg = await r.json();
    await api('PUT', `/channels/${ch.id}/pins/${msg.id}`);
    console.log(`  ✓ posted + pinned banner (${msg.id})`);
  } else {
    console.log('  ✓ banner already pinned');
  }

  if (!hasEmbed) {
    const msg = await api('POST', `/channels/${ch.id}/messages`, { embeds: [buildInfoEmbed()] });
    await api('PUT', `/channels/${ch.id}/pins/${msg.id}`);
    console.log(`  ✓ posted + pinned info embed (${msg.id})`);
  } else {
    console.log('  ✓ info embed already pinned');
  }
}

// ── Phase 6: verification ────────────────────────────────────────────────
async function phase6_verify() {
  console.log('\n═══ Phase 6: Verification ═══');
  let pass = 0, fail = 0;

  const roles = await api('GET', `/guilds/${GUILD_ID}/roles`);

  if (roles.find(r => r.id === ROLE.KANRISHA)) {
    console.log(`  ✗ Kanrisha role STILL EXISTS`); fail++;
  } else {
    console.log(`  ✓ Kanrisha role gone`); pass++;
  }

  for (const [rid, target] of Object.entries(ROLE_PERMS)) {
    const role = roles.find(r => r.id === rid);
    if (!role) { console.log(`  ✗ role ${rid} missing`); fail++; continue; }
    const cur = BigInt(role.permissions);
    if (cur === target) {
      console.log(`  ✓ ${role.name} perms aligned`); pass++;
    } else {
      console.log(`  ✗ ${role.name} perms mismatch: ${cur} ≠ ${target}`); fail++;
    }
  }

  for (const m of MEMBER_ROLES) {
    const member = await api('GET', `/guilds/${GUILD_ID}/members/${m.uid}`);
    if (member?.__notfound) {
      console.log(`  ⚠ ${m.uid} not in guild (expected)`); continue;
    }
    const username = member.user?.username || m.uid;
    if (Array.isArray(member.roles) && member.roles.includes(m.role)) {
      console.log(`  ✓ ${username} has ${m.note}`); pass++;
    } else {
      console.log(`  ✗ ${username} missing ${m.note}`); fail++;
    }
  }

  console.log(`\n  Verification summary: ${pass} pass, ${fail} fail`);
  return fail === 0;
}

// ── main ────────────────────────────────────────────────────────────────
try {
  console.log(`Kitsune authoritative structure — guild ${GUILD_ID}, bot ${BOT_ID}`);
  await phase1_rolePerms();
  await phase2_killKanrisha();
  await phase3_memberSync();
  await phase4_channelOverwrites();
  await phase5_aboutCertifried();
  const ok = await phase6_verify();
  console.log(ok ? '\n🎉 All phases complete — verification clean.' : '\n⚠ Phases complete but verification flagged issues — review above.');
} catch (e) {
  console.error('\n❌ Script failed:', e.message);
  if (e.stack) console.error(e.stack);
  process.exitCode = 1;
} finally {
  await pool.end();
}
