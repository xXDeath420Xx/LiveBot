/*
 * Garuda Team (729650115844898817) — full server build, run by ICBN Laser (1528177973469909163).
 *
 *   node scripts/setup-garuda-team.mjs <phase>
 *     phases: roles | channels | config | panels | games | streaming | all | show
 *
 * Idempotent: every entity is keyed by a stable slug in scripts/.garuda-setup-ids.json.
 * Re-running a phase reuses existing Discord objects (find-by-name / stored id) instead of duplicating.
 * All Discord ops are REST via the custom bot token (safe while PM2 runs — no gateway login).
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD = '729650115844898817';
// The acting bot comes from guild_bot_mapping — never pinned here.
const BOT_ROLE_ID = '1528180082152181921'; // ICBN Laser managed role (assignable roles go below this)
const IDS_PATH = new URL('./.garuda-setup-ids.json', import.meta.url);

// ── infra ──────────────────────────────────────────────────────────────────
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const bot = await resolveBotForGuild(GUILD, { db });
const TOKEN = bot.token;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asciiReason = (s) => s.replace(/[^\x20-\x7E]/g, '').slice(0, 300);

async function rest(method, path, body, reason) {
  const url = `https://discord.com/api/v10${path}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' };
    if (reason) headers['X-Audit-Log-Reason'] = asciiReason(reason);
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const wait = Math.ceil((j.retry_after || 1) * 1000) + 250;
      console.log(`  · 429 on ${method} ${path} — waiting ${wait}ms`);
      await sleep(wait); continue;
    }
    if (res.status >= 500) { await sleep(750); continue; }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return data;
  }
  throw new Error(`${method} ${path} -> exhausted retries`);
}

// ── id map persistence ───────────────────────────────────────────────────────
const IDS = existsSync(IDS_PATH) ? JSON.parse(readFileSync(IDS_PATH, 'utf8'))
  : { roles: {}, categories: {}, channels: {}, panels: {} };
const saveIds = () => writeFileSync(IDS_PATH, JSON.stringify(IDS, null, 2));

// live guild state (refreshed per phase)
let guildRoles = [], guildChannels = [];
async function refresh() {
  guildRoles = await rest('GET', `/guilds/${GUILD}/roles`);
  guildChannels = await rest('GET', `/guilds/${GUILD}/channels`);
}

const C = { // themed palette
  grey: 0x607d8b, blue: 0x3498db, gold: 0xf1c40f, red: 0x992d22, purple: 0x9146ff,
  green: 0x2ecc71, teal: 0x1abc9c, pink: 0xe91e63, sky: 0x5dade2, orange: 0xe67e22,
  navy: 0x2c3e50, white: 0x99aab5,
};

// ── ROLES ────────────────────────────────────────────────────────────────────
// action: 'rename' reuses an existing role id (repurpose placeholder); 'create' makes new.
const FUNCTIONAL_ROLES = [
  { slug: 'grounded',   name: 'Grounded',      color: C.grey,   hoist: false, from: '1528079531892670645' }, // Fifth
  { slug: 'squadron',   name: 'Squadron',      color: C.blue,   hoist: true,  from: '1512609152491327670' }, // Gunner (join-gate role)
  { slug: 'age18',      name: '18+',           color: C.red,    hoist: false },
  { slug: 'age21',      name: '21+',           color: C.red,    hoist: false },
  { slug: 'onair',      name: 'On Air',        color: C.purple, hoist: true },
  { slug: 'birthday',   name: 'Ace of the Day',color: C.gold,   hoist: false, from: '1528079504428367972' }, // Fourth
  { slug: 'twitch_vip', name: 'Twitch VIP',    color: C.pink,   hoist: false },
  { slug: 'twitch_mod', name: 'Twitch Mod',    color: C.green,  hoist: false },
  { slug: 'support',    name: 'Support',       color: C.teal,   hoist: false },
];

const REACTION_PANELS = [
  { slug: 'ping',     name: 'Ping Preferences', mode: 'multiple', color: C.sky,
    roles: [['ping_stream','Stream Pings','📢'],['ping_freegames','Free Games','🎁'],['ping_events','Events','📅'],['ping_qotd','QOTD','💬']] },
  { slug: 'platform', name: 'Platform', mode: 'multiple', color: C.navy,
    roles: [['plat_pc','PC','🖥️'],['plat_xbox','Xbox','🎮'],['plat_ps','PlayStation','🕹️'],['plat_switch','Switch','🔴'],['plat_mobile','Mobile','📱']] },
  { slug: 'games',    name: 'Game Roles', mode: 'multiple', color: C.orange,
    roles: [['game_fortnite','Fortnite','🛡️'],['game_minecraft','Minecraft','⛏️'],['game_amongus','Among Us','🔪'],['game_party','Party Games','🎉'],['game_acecombat','Ace Combat','✈️'],['game_warthunder','War Thunder','💥'],['game_streamer','Streamer','🎥']] },
  { slug: 'region',   name: 'Region', mode: 'multiple', color: C.teal,
    roles: [['reg_na','North America','🌎'],['reg_sa','South America','🌎'],['reg_eu','Europe','🌍'],['reg_af','Africa','🌍'],['reg_as','Asia','🌏'],['reg_oc','Oceania','🌏'],['reg_me','Middle East','🕌']] },
  { slug: 'pronouns', name: 'Pronouns', mode: 'multiple', color: C.pink,
    roles: [['pro_he','He/Him','💙'],['pro_she','She/Her','💗'],['pro_they','They/Them','💜'],['pro_ask','Ask','💛']] },
  { slug: 'timezone', name: 'Timezone', mode: 'unique', color: C.blue,
    roles: [['tz_pst','PST','🇺🇸'],['tz_mst','MST','🏔️'],['tz_cst','CST','🌾'],['tz_est','EST','🗽'],['tz_ast','AST','🌊'],['tz_gmt','GMT/UTC','🌐'],['tz_cet','CET','🇪🇺'],['tz_eet','EET','🏛️'],['tz_msk','MSK','❄️'],['tz_ist','IST','🇮🇳'],['tz_aest','AEST','🦘'],['tz_nzst','NZST','🥝']] },
  { slug: 'zodiac',   name: 'Zodiac', mode: 'multiple', color: C.gold,
    roles: [['zod_aries','Aries','♈'],['zod_taurus','Taurus','♉'],['zod_gemini','Gemini','♊'],['zod_cancer','Cancer','♋'],['zod_leo','Leo','♌'],['zod_virgo','Virgo','♍'],['zod_libra','Libra','♎'],['zod_scorpio','Scorpio','♏'],['zod_sagittarius','Sagittarius','♐'],['zod_capricorn','Capricorn','♑'],['zod_aquarius','Aquarius','♒'],['zod_pisces','Pisces','♓']] },
];

function findRoleByName(name) { return guildRoles.find((r) => r.name === name); }

async function ensureRole(slug, name, color, hoist, fromId) {
  // already tracked?
  if (IDS.roles[slug]) {
    const existing = guildRoles.find((r) => r.id === IDS.roles[slug]);
    if (existing) {
      if (existing.name !== name || existing.color !== color) {
        await rest('PATCH', `/guilds/${GUILD}/roles/${existing.id}`, { name, color }, 'Garuda setup: normalize role');
        await sleep(300);
      }
      return existing.id;
    }
  }
  // reuse a same-named role if present
  const byName = findRoleByName(name);
  if (byName) { IDS.roles[slug] = byName.id; return byName.id; }
  // repurpose a placeholder by id
  if (fromId && guildRoles.find((r) => r.id === fromId)) {
    await rest('PATCH', `/guilds/${GUILD}/roles/${fromId}`, { name, color, hoist }, `Garuda setup: repurpose to ${name}`);
    IDS.roles[slug] = fromId; await sleep(320); return fromId;
  }
  // create fresh
  const created = await rest('POST', `/guilds/${GUILD}/roles`,
    { name, color, hoist, mentionable: false, permissions: '0' }, `Garuda setup: create ${name}`);
  IDS.roles[slug] = created.id; guildRoles.push(created); await sleep(320);
  return created.id;
}

async function phaseRoles() {
  await refresh();
  console.log('— functional roles —');
  for (const r of FUNCTIONAL_ROLES) {
    const id = await ensureRole(r.slug, r.name, r.color, r.hoist, r.from);
    console.log(`  ${r.name.padEnd(16)} ${id}`);
    saveIds();
  }
  console.log('— reaction-role roles —');
  for (const p of REACTION_PANELS) {
    for (const [slug, name] of p.roles) {
      const id = await ensureRole(slug, name, p.color, false, null);
      console.log(`  [${p.slug}] ${name.padEnd(16)} ${id}`);
      saveIds();
    }
  }
  saveIds();
  console.log(`\nDone. ${Object.keys(IDS.roles).length} roles tracked in .garuda-setup-ids.json`);
}

// ── CHANNELS & PERMISSIONS ────────────────────────────────────────────────────
const B = {
  VIEW: 1n << 10n, SEND: 1n << 11n, HISTORY: 1n << 16n, ADDREACT: 1n << 6n,
  EMBED: 1n << 14n, ATTACH: 1n << 15n, EXTEMOJI: 1n << 18n, APPCMDS: 1n << 31n,
  CONNECT: 1n << 20n, SPEAK: 1n << 21n, USEVAD: 1n << 25n, VIDEO: 1n << 9n,
  MANAGE_MSG: 1n << 13n, MENTION_EVERYONE: 1n << 17n, CREATE_THREAD: 1n << 34n, SEND_THREAD: 1n << 38n,
};
const TEXT_MEMBER = B.VIEW | B.SEND | B.HISTORY | B.ADDREACT | B.EMBED | B.ATTACH | B.EXTEMOJI | B.APPCMDS | B.CREATE_THREAD | B.SEND_THREAD;
const VOICE_MEMBER = B.VIEW | B.CONNECT | B.SPEAK | B.USEVAD | B.VIDEO;
const READ_ONLY_ALLOW = B.VIEW | B.HISTORY;
const READ_ONLY_DENY = B.SEND | B.ADDREACT | B.CREATE_THREAD | B.SEND_THREAD;

const STAFF_ROLES = ['729651083256922123', '1512609204203028671', '729651167927468142']; // Garuda One, The Missile, AWACS
const ow = (id, allow, deny) => ({ id, type: 0, allow: String(allow), deny: String(deny) });
const R = (slug) => IDS.roles[slug];
const EVERYONE = GUILD;

function categoryDefs() {
  const sq = R('squadron'), a18 = R('age18'), sup = R('support');
  return [
    { slug: 'information', name: '📋 INFORMATION',
      ow: [ow(EVERYONE, READ_ONLY_ALLOW, READ_ONLY_DENY)] },
    { slug: 'hq', name: '✈️ SQUADRON HQ',
      ow: [ow(EVERYONE, 0n, B.VIEW), ow(sq, TEXT_MEMBER, 0n)] },
    { slug: 'games', name: '🎮 GAMES',
      ow: [ow(EVERYONE, 0n, B.VIEW), ow(sq, TEXT_MEMBER, 0n)] },
    { slug: 'lounge420', name: '🌿 420 LOUNGE',
      ow: [ow(EVERYONE, 0n, B.VIEW), ow(a18, TEXT_MEMBER | VOICE_MEMBER, 0n)] },
    { slug: 'streams', name: '📡 STREAMS',
      ow: [ow(EVERYONE, 0n, B.VIEW), ow(sq, READ_ONLY_ALLOW, READ_ONLY_DENY)] },
    { slug: 'support', name: '🎫 SUPPORT',
      ow: [ow(EVERYONE, 0n, B.VIEW), ow(sq, READ_ONLY_ALLOW, READ_ONLY_DENY)] },
    { slug: 'voice', name: '🔊 VOICE',
      ow: [ow(EVERYONE, 0n, B.VIEW), ow(sq, VOICE_MEMBER, 0n)] },
    { slug: 'stats', name: '📊 SERVER STATS',
      ow: [ow(EVERYONE, B.VIEW, B.CONNECT)] },
    { slug: 'staff', name: '🛠️ STAFF',
      ow: [ow(EVERYONE, 0n, B.VIEW), ...STAFF_ROLES.map((r) => ow(r, TEXT_MEMBER | B.MANAGE_MSG, 0n)), ow(sup, TEXT_MEMBER, 0n)] },
    { slug: 'tickets', name: '🎫 TICKETS',
      ow: [ow(EVERYONE, 0n, B.VIEW), ...STAFF_ROLES.map((r) => ow(r, TEXT_MEMBER | B.MANAGE_MSG, 0n)), ow(sup, TEXT_MEMBER, 0n)] },
  ];
}

// channel defs: [slug, name, type(0/2), catSlug, existingId|null, owOverride|null]
function channelDefs() {
  const sq = R('squadron');
  const memberViewNoSend = [ow(EVERYONE, 0n, B.VIEW), ow(sq, B.VIEW | B.HISTORY | B.ADDREACT | B.APPCMDS, B.SEND | B.CREATE_THREAD | B.SEND_THREAD)];
  const selfPromo = [ow(EVERYONE, 0n, B.VIEW), ow(sq, B.VIEW | B.SEND | B.HISTORY | B.EMBED | B.ATTACH | B.APPCMDS, 0n)];
  return [
    // INFORMATION
    ['welcome', 'welcome', 0, 'information', '729650116620845118', null],
    ['rules', 'rules', 0, 'information', null, null],
    ['announcements', 'announcements', 0, 'information', null, null],
    ['get_roles', 'get-roles', 0, 'information', null, [ow(EVERYONE, 0n, B.VIEW), ow(sq, B.VIEW | B.HISTORY, B.SEND | B.ADDREACT)]],
    // SQUADRON HQ
    ['chat', 'chat', 0, 'hq', '729650244224155719', null],
    ['media', 'media', 0, 'hq', null, null],
    ['suggestions', 'suggestions', 0, 'hq', null, memberViewNoSend],
    ['qotd', 'qotd', 0, 'hq', null, null],
    ['confessions', 'confessions', 0, 'hq', null, memberViewNoSend],
    ['birthdays', 'birthdays', 0, 'hq', null, memberViewNoSend],
    // GAMES
    ['counting', 'counting', 0, 'games', null, null],
    ['tree', 'grow-a-tree', 0, 'games', null, null],
    ['catcafe', 'cat-cafe', 0, 'games', null, null],
    ['botcommands', 'bot-commands', 0, 'games', null, null],
    // 420
    ['thesesh', 'the-sesh', 0, 'lounge420', null, null],
    ['voice420', '420 Lounge', 2, 'lounge420', null, null],
    // STREAMS
    ['takingflight', 'taking-flight', 0, 'streams', '1528186131089326281', null],
    ['wingmen', 'wingmen-taking-flight', 0, 'streams', '1528081391932145826', selfPromo],
    ['streamschedule', 'stream-schedule', 0, 'streams', null, null],
    // SUPPORT
    ['supportch', 'support', 0, 'support', null, null],
    // VOICE
    ['vc_general', 'General', 2, 'voice', '729650116620845119', null],
    ['vc_live', 'Live?', 2, 'voice', '1364615960211882014', null],
    ['vc_squadron', 'Squadron Comms', 2, 'voice', null, null],
    ['vc_afk', 'AFK', 2, 'voice', null, null],
    // STATS (view-only voice display)
    ['stat_time', '🕐 | loading…', 2, 'stats', null, null],
    ['stat_date', '📅 | loading…', 2, 'stats', null, null],
    ['stat_members', '👤 | loading…', 2, 'stats', null, null],
    // STAFF
    ['modlog', 'bot-mod-log', 0, 'staff', '1528078175878254735', null],
    ['staffchat', 'staff-chat', 0, 'staff', null, null],
    ['modalerts', 'mod-alerts', 0, 'staff', null, null],
  ];
}

async function ensureCategory(def, position) {
  let id = IDS.categories[def.slug];
  let cur = id ? guildChannels.find((c) => c.id === id) : guildChannels.find((c) => c.type === 4 && c.name === def.name);
  if (cur) {
    id = cur.id;
    await rest('PATCH', `/channels/${id}`, { name: def.name, position, permission_overwrites: def.ow }, 'Garuda setup: category perms');
  } else {
    const created = await rest('POST', `/guilds/${GUILD}/channels`,
      { name: def.name, type: 4, position, permission_overwrites: def.ow }, 'Garuda setup: create category');
    id = created.id; guildChannels.push(created);
  }
  IDS.categories[def.slug] = id; saveIds(); await sleep(380);
  return id;
}

async function ensureChannel([slug, name, type, catSlug, existingId, owOverride], position, catOwById) {
  const parent_id = IDS.categories[catSlug];
  const overwrites = owOverride || catOwById; // sync to category unless override
  let id = IDS.channels[slug] || existingId;
  let cur = id ? guildChannels.find((c) => c.id === id) : guildChannels.find((c) => c.name === name && c.parent_id === parent_id);
  if (cur) {
    id = cur.id;
    const patch = { parent_id, position, permission_overwrites: overwrites };
    await rest('PATCH', `/channels/${id}`, patch, 'Garuda setup: place/permission channel');
  } else {
    const created = await rest('POST', `/guilds/${GUILD}/channels`,
      { name, type, parent_id, position, permission_overwrites: overwrites }, 'Garuda setup: create channel');
    id = created.id; guildChannels.push(created);
  }
  IDS.channels[slug] = id; saveIds(); await sleep(380);
  return id;
}

async function phaseChannels() {
  await refresh();
  // 1) strip MENTION_EVERYONE from @everyone base perms
  const everyoneRole = guildRoles.find((r) => r.id === EVERYONE);
  const curPerms = BigInt(everyoneRole.permissions);
  if (curPerms & B.MENTION_EVERYONE) {
    await rest('PATCH', `/guilds/${GUILD}/roles/${EVERYONE}`,
      { permissions: String(curPerms & ~B.MENTION_EVERYONE) }, 'Garuda setup: harden @everyone');
    console.log('· removed MENTION_EVERYONE from @everyone');
    await sleep(320);
  }
  // 2) categories (ordered; positions leave room for existing "Text/Voice Channels" cats at bottom)
  const cats = categoryDefs();
  const catOw = {};
  let pos = 0;
  for (const def of cats) {
    const id = await ensureCategory(def, pos++);
    catOw[def.slug] = def.ow;
    console.log(`▼ ${def.name.padEnd(20)} ${id}`);
  }
  // 3) channels
  const defs = channelDefs();
  const perCat = {};
  for (const d of defs) { (perCat[d[3]] ||= []).push(d); }
  for (const catSlug of Object.keys(perCat)) {
    let cpos = 0;
    for (const d of perCat[catSlug]) {
      const id = await ensureChannel(d, cpos++, catOw[catSlug]);
      console.log(`   #${d[1].padEnd(22)} ${id}${d[4] ? ' (integrated)' : ''}`);
    }
  }
  saveIds();
  console.log(`\nChannels done. ${Object.keys(IDS.channels).length} channels, ${Object.keys(IDS.categories).length} categories.`);
}

// ── CONFIG (clone-and-remap from Karabi 814 → Garuda 729) ─────────────────────
const KARABI = '814321716872347648';
const CH = (slug) => IDS.channels[slug];
const CAT = (slug) => IDS.categories[slug];

async function autoIncCols(table) {
  const [cols] = await db.query(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND EXTRA LIKE "%auto_increment%"', [table]);
  return cols.map((c) => c.COLUMN_NAME);
}
// clone a single guild-scoped row; delete existing Garuda row(s) first for idempotency
async function cloneOne(table, overrides = {}, { where = 'guild_id=? LIMIT 1', params = [KARABI], drop = ['created_at', 'updated_at'] } = {}) {
  const [rows] = await db.query(`SELECT * FROM \`${table}\` WHERE ${where}`, params);
  if (!rows.length) { console.log(`  ${table}: no source row — skip`); return false; }
  const row = { ...rows[0] };
  for (const ai of await autoIncCols(table)) delete row[ai];
  for (const d of drop) delete row[d];
  row.guild_id = GUILD;
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in row)) { console.log(`  ${table}: WARN override '${k}' not a column`); continue; }
    row[k] = v;
  }
  await db.query(`DELETE FROM \`${table}\` WHERE guild_id=?`, [GUILD]);
  const keys = Object.keys(row);
  await db.query(`INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k]));
  console.log(`  ${table}: cloned (${keys.length} cols)`);
  return true;
}
async function upd(table, sets, extra = '') {
  const keys = Object.keys(sets);
  const [r] = await db.query(`UPDATE \`${table}\` SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE guild_id=? ${extra}`, [...keys.map((k) => sets[k]), GUILD]);
  console.log(`  ${table}: updated ${r.affectedRows} row(s)`);
}

async function phaseConfig() {
  const modalerts = CH('modalerts'), modlog = CH('modlog');
  console.log('— protection —');
  await cloneOne('anti_nuke_config', { alert_channel_id: modalerts });
  await cloneOne('raid_detection_config', { alert_channel_id: modalerts });
  await cloneOne('phishing_config', { alert_channel_id: modalerts, report_channel_id: modalerts });

  console.log('— onboarding —');
  await cloneOne('verify_config', { verified_role_id: R('squadron'), unverified_role_id: R('grounded'), gate_channel_id: CH('rules'), gate_message_id: null });
  await upd('welcome_settings', { channel_id: '729650116620845118', message: 'Welcome to **Garuda Team**, {user}! ✈️ Head to <#' + CH('rules') + '> to check in, then grab your roles in <#' + CH('get_roles') + '>.', auto_role_id: R('grounded'), card_title_text: 'Welcome, {user}!', card_subtitle_text: 'Cleared for approach — {server}' });

  console.log('— engagement —');
  await cloneOne('birthday_config', { announcement_channel_id: CH('birthdays'), birthday_role_id: R('birthday') });
  await cloneOne('confession_config', { channel_id: CH('confessions') });
  await cloneOne('suggestion_config', { suggestions_channel_id: CH('suggestions') });
  await cloneOne('event_schedule_config', { channel_id: CH('announcements'), timezone: 'America/New_York' });
  await upd('level_config', { level_up_channel_id: CH('botcommands') });
  // QOTD: clone channel config + deck
  await cloneQotd();
  // timezone: EST in all three stores
  await cloneOne('tz_guild_config', { time_zone: 'America/New_York' });
  await upd('guild_settings', { timezone: 'America/New_York' });
  await db.query('UPDATE guild_config SET timezone=? WHERE guild_id=?', ['America/New_York', GUILD]).then(() => console.log('  guild_config: tz=America/New_York')).catch((e) => console.log('  guild_config tz:', e.message));

  console.log('— games —');
  await cloneOne('counting_channels', { channel_id: CH('counting'), current_count: 0, highest_count: 0, last_user_id: null, is_active: 1, fail_mode: 'delete', allow_same_user: 1, delete_chatter: 1, react_on_valid: 1 });
  await cloneOne('catbot_channels', { channel_id: CH('catcafe'), cat_message_id: null, cat_type: null, spawned_at: 0, yet_to_spawn: Math.floor(Date.now() / 1000), rain_left: 0 });

  console.log('— logging —');
  await cloneOne('logging_config', { log_channel_id: modlog });
  await cloneLogEvents(modlog);
  await cloneStatChannels();

  console.log('— command restrictions (games + 420) —');
  await db.query('DELETE FROM guild_command_restrictions WHERE guild_id=?', [GUILD]);
  const restr = [['cat', CH('catcafe')], ['tree', CH('tree')], ['cannabis', CH('thesesh')], ['cheers', CH('thesesh')]];
  for (const [cmd, ch] of restr) {
    await db.query('INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only, channel_id) VALUES (?,?,1,0,?)', [GUILD, cmd, ch]);
  }
  console.log(`  ${restr.length} command restrictions set`);

  console.log('\nConfig phase done.');
}

async function cloneLogEvents(modlog) {
  const [rows] = await db.query('SELECT * FROM log_event_config WHERE guild_id=?', [KARABI]);
  if (!rows.length) { console.log('  log_event_config: none'); return; }
  await db.query('DELETE FROM log_event_config WHERE guild_id=?', [GUILD]);
  const ai = await autoIncCols('log_event_config');
  for (const src of rows) {
    const row = { ...src };
    for (const a of ai) delete row[a];
    delete row.created_at; delete row.updated_at;
    row.guild_id = GUILD;
    if ('log_channel_id' in row && row.log_channel_id) row.log_channel_id = modlog;
    const keys = Object.keys(row);
    await db.query(`INSERT INTO log_event_config (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k]));
  }
  console.log(`  log_event_config: cloned ${rows.length} events`);
}

async function cloneStatChannels() {
  const [rows] = await db.query('SELECT * FROM stat_display_channels WHERE guild_id=?', [KARABI]);
  await db.query('DELETE FROM stat_display_channels WHERE guild_id=?', [GUILD]);
  const map = { time: CH('stat_time'), date: CH('stat_date') };
  const ai = await autoIncCols('stat_display_channels');
  let n = 0;
  for (const src of rows) {
    if (!map[src.stat_type]) continue;
    const row = { ...src }; for (const a of ai) delete row[a]; delete row.created_at;
    row.guild_id = GUILD; row.channel_id = map[src.stat_type];
    const keys = Object.keys(row);
    await db.query(`INSERT INTO stat_display_channels (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k]));
    n++;
  }
  // add a members counter
  await db.query('INSERT INTO stat_display_channels (guild_id, channel_id, stat_type, template) VALUES (?,?,?,?)', [GUILD, CH('stat_members'), 'members', '👤 | {value}']);
  console.log(`  stat_display_channels: ${n + 1} channels`);
}

async function cloneQotd() {
  // clone the deck + its questions, then point qotd_channels at the new deck
  let newDeckId = null;
  try {
    const [decks] = await db.query('SELECT * FROM qotd_decks WHERE guild_id=? LIMIT 1', [KARABI]);
    if (decks.length) {
      const oldDeckId = decks[0].deck_id ?? decks[0].id;
      // clean any prior Garuda decks + their cards (idempotent re-run)
      const [priorDecks] = await db.query('SELECT deck_id FROM qotd_decks WHERE guild_id=?', [GUILD]).catch(() => [[]]);
      const priorIds = priorDecks.map((d) => d.deck_id).filter(Boolean);
      if (priorIds.length) {
        const qtabsPrior = await db.query('SELECT DISTINCT TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME="deck_id" AND TABLE_NAME LIKE "qotd%"').then((r) => r[0]);
        for (const { TABLE_NAME } of qtabsPrior) {
          if (TABLE_NAME === 'qotd_decks') continue;
          await db.query(`DELETE FROM \`${TABLE_NAME}\` WHERE deck_id IN (${priorIds.map(() => '?').join(',')})`, priorIds).catch(() => {});
        }
      }
      await db.query('DELETE FROM qotd_decks WHERE guild_id=?', [GUILD]);
      const row = { ...decks[0] }; for (const a of await autoIncCols('qotd_decks')) delete row[a];
      delete row.created_at; delete row.updated_at; row.guild_id = GUILD;
      const keys = Object.keys(row);
      const [ins] = await db.query(`INSERT INTO qotd_decks (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k]));
      newDeckId = ins.insertId;
      // clone questions if a deck-scoped question table exists
      const [qtabs] = await db.query('SELECT DISTINCT TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME="deck_id" AND TABLE_NAME LIKE "qotd%"');
      for (const { TABLE_NAME } of qtabs) {
        if (TABLE_NAME === 'qotd_decks') continue;
        const [qs] = await db.query(`SELECT * FROM \`${TABLE_NAME}\` WHERE deck_id=?`, [oldDeckId]);
        const ai = await autoIncCols(TABLE_NAME);
        for (const q of qs) { const r = { ...q }; for (const a of ai) delete r[a]; r.deck_id = newDeckId; const ks = Object.keys(r); await db.query(`INSERT INTO \`${TABLE_NAME}\` (${ks.map((k) => `\`${k}\``).join(',')}) VALUES (${ks.map(() => '?').join(',')})`, ks.map((k) => r[k])); }
        if (qs.length) console.log(`  qotd questions: cloned ${qs.length} from ${TABLE_NAME}`);
      }
    }
  } catch (e) { console.log('  qotd deck clone warn:', e.message); }
  await cloneOne('qotd_channels', { channel_id: CH('qotd'), timezone: 'America/New_York', active_deck_id: newDeckId, last_posted_at: null }, { drop: [] });
}

// ── PANELS (post messages + wire DB) ──────────────────────────────────────────
const hex = (n) => '#' + n.toString(16).padStart(6, '0').toUpperCase();
async function postMessage(channelId, payload) {
  const m = await rest('POST', `/channels/${channelId}/messages`, payload, null);
  await sleep(400);
  return m;
}
function buttonRows(items, style = 2) { // items: [customId, label, emoji]
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push({ type: 1, components: items.slice(i, i + 5).map(([cid, label, emoji]) => ({
      type: 2, style, label, custom_id: cid, ...(emoji ? { emoji: { name: emoji } } : {}),
    })) });
  }
  return rows;
}

const AGE_PANEL = { slug: 'age', name: 'Age Check', mode: 'multiple', color: C.red,
  roles: [['age18', '18+', '🔞'], ['age21', '21+', '🔞']],
  desc: 'Confirm your age to unlock the 🌿 420 Lounge. By clicking you attest you meet the age requirement.' };

async function phasePanels() {
  await refresh();
  // 1) verify gate in #rules
  if (!IDS.panels.verify) {
    const embed = {
      title: '✈️ Welcome to Garuda Team — Check In',
      color: C.blue,
      description: [
        'Before you get clearance, read and agree to the rules:',
        '',
        '**1.** Be respectful — no harassment, hate, or bigotry.',
        '**2.** No spam, self-promo, or NSFW outside gated channels.',
        '**3.** Keep it legal. Follow Discord ToS & Community Guidelines.',
        '**4.** Listen to staff (Garuda One, The Missile, AWACS).',
        '**5.** Use channels for their purpose.',
        '',
        'Click **I Agree** below to get the **Squadron** role and access the server.',
      ].join('\n'),
    };
    const row = { type: 1, components: [{ type: 2, style: 3, label: 'I Agree — Verify Me', custom_id: 'verify_accept', emoji: { name: '✅' } }] };
    const msg = await postMessage(CH('rules'), { embeds: [embed], components: [row] });
    await db.query('UPDATE verify_config SET gate_message_id=? WHERE guild_id=?', [msg.id, GUILD]);
    IDS.panels.verify = msg.id; saveIds();
    console.log(`  verify gate posted ${msg.id}`);
  } else console.log('  verify gate: already posted');

  // 2) reaction-role panels (+age) in #get-roles
  const panels = [AGE_PANEL, ...REACTION_PANELS];
  for (const p of panels) {
    if (IDS.panels[p.slug]) { console.log(`  panel ${p.slug}: already posted`); continue; }
    const items = p.roles.map(([slug, label, emoji]) => [`rr_${R(slug)}`, label, emoji]);
    const embed = { title: p.name, color: p.color,
      description: (p.desc || `Pick your **${p.name}** role${p.mode === 'unique' ? ' (one only)' : 's'} below.`) };
    const msg = await postMessage(CH('get_roles'), { embeds: [embed], components: buttonRows(items) });
    // DB panel + mappings
    const [ins] = await db.query(
      `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
       VALUES (?,?,?,?,?,?, 'button', ?)`,
      [GUILD, CH('get_roles'), msg.id, p.name, embed.description, hex(p.color), p.mode]);
    const panelId = ins.insertId;
    for (const [slug, label, emoji] of p.roles) {
      await db.query('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?,?,?,?,2)', [panelId, R(slug), emoji, label]);
    }
    IDS.panels[p.slug] = msg.id; saveIds();
    console.log(`  panel ${p.slug}: posted ${msg.id} (${p.roles.length} roles)`);
  }

  // 3) ticket panel in #support
  if (!IDS.panels.ticket) {
    const [ins] = await db.query(
      `INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color, button_text, button_emoji, ticket_category_id, support_role_id, ticket_name_format, save_transcripts, log_channel_id, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,1)`,
      [GUILD, 'Support', CH('supportch'), '🎫 Support', 'Need help or want to reach staff? Open a ticket and the team will assist you.', '#3498DB', 'Open a Ticket', '🎫', CAT('tickets'), R('support'), 'ticket-{username}', CH('modlog')]);
    const panelId = ins.insertId;
    const embed = { title: '🎫 Support', color: C.blue, description: 'Need help or want to reach staff? Click below to open a private ticket.' };
    const row = { type: 1, components: [{ type: 2, style: 1, label: 'Open a Ticket', custom_id: `ticket_create_panel_${panelId}`, emoji: { name: '🎫' } }] };
    const msg = await postMessage(CH('supportch'), { embeds: [embed], components: [row] });
    await db.query('UPDATE ticket_panels SET panel_message_id=? WHERE panel_id=?', [msg.id, panelId]);
    IDS.panels.ticket = msg.id; saveIds();
    console.log(`  ticket panel posted ${msg.id} (panel ${panelId})`);
  } else console.log('  ticket panel: already posted');

  console.log('\nPanels phase done.');
}

// ── EXTRAS: tree, automod, streaming ──────────────────────────────────────────
const OWNER = '268803397119901696'; // garudaone0
const GARUDA_TEAM_ROLE = '1064372122090221618';
const TAKING_FLIGHT = '1528186131089326281';

async function phaseExtras() {
  await refresh();
  // 1) plant a fresh Garuda tree
  await db.query('DELETE FROM gat_trees WHERE guild_id=?', [GUILD]);
  await db.query(
    'INSERT INTO gat_trees (guild_id, name, size, pieces, background, last_watered_by, last_watered_at, planted_by, compost) VALUES (?,?,0,?,?,?,?,?,0)',
    [GUILD, 'Garuda', '[]', 'Sky', OWNER, Math.floor(Date.now() / 1000), OWNER]);
  console.log('· planted tree "Garuda"');

  // 2) AutoMod rules (idempotent by name)
  const existing = await rest('GET', `/guilds/${GUILD}/auto-moderation/rules`).catch(() => []);
  const have = new Set((Array.isArray(existing) ? existing : []).map((r) => r.name));
  const alert = { type: 2, metadata: { channel_id: CH('modalerts') } };
  const block = { type: 1, metadata: { custom_message: 'Blocked by Garuda AutoMod.' } };
  const rules = [
    { name: 'Garuda • Spam', event_type: 1, trigger_type: 3, actions: [block, alert] },
    { name: 'Garuda • Mention Spam', event_type: 1, trigger_type: 5, trigger_metadata: { mention_total_limit: 6 }, actions: [block, alert] },
    { name: 'Garuda • Slurs', event_type: 1, trigger_type: 4, trigger_metadata: { presets: [3] }, actions: [block, alert] },
    { name: 'Garuda • Invite Links', event_type: 1, trigger_type: 1, trigger_metadata: { regex_patterns: ['(discord\\.(gg|io|me|li)|discordapp\\.com/invite)/[a-zA-Z0-9]+'] }, actions: [block, alert] },
  ];
  for (const r of rules) {
    if (have.has(r.name)) { console.log(`· automod ${r.name}: exists`); continue; }
    await rest('POST', `/guilds/${GUILD}/auto-moderation/rules`, { ...r, enabled: true, exempt_roles: STAFF_ROLES }, 'Garuda setup: automod');
    console.log(`· automod ${r.name}: created`);
    await sleep(400);
  }

  // 3) streaming re-enable (announcer repost bug is fixed + verified)
  await db.query('UPDATE self_promo_config SET enabled=1, auto_subscribe=1, channel_id=? WHERE guild_id=?', ['1528081391932145826', GUILD]);
  console.log('· self_promo: enabled (channel #wingmen-taking-flight)');
  await db.query('DELETE FROM guild_streamer_auto_track WHERE guild_id=?', [GUILD]);
  await db.query(
    'INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, live_role_id, min_level, enabled, delete_on_end, edit_on_end) VALUES (?,?,?,?,0,1,0,1)',
    [GUILD, GARUDA_TEAM_ROLE, TAKING_FLIGHT, R('onair')]);
  console.log('· guild_streamer_auto_track: re-enabled (#taking-flight, live role On Air)');
  await db.query('UPDATE twitch_role_sync_config SET vip_role_id=?, mod_role_id=? WHERE guild_id=?', [R('twitch_vip'), R('twitch_mod'), GUILD]);
  console.log('· twitch_role_sync: VIP/Mod roles mapped (owner must re-auth OAuth)');
  await cloneOne('twitch_schedule_sync_config',
    { streamer_id: 7305, discord_channel_id: CH('streamschedule'), last_message_id: null, schedule_hash: null, previous_segments_json: null, last_synced: null, last_weekly_refresh: null, change_detected_at: null },
    { drop: [] });
  console.log('· twitch_schedule_sync: → #stream-schedule (garudaone0)');

  console.log('\nExtras phase done.');
}

// ── dispatch ──────────────────────────────────────────────────────────────────
const phase = process.argv[2] || 'show';
try {
  if (phase === 'roles') await phaseRoles();
  else if (phase === 'channels') await phaseChannels();
  else if (phase === 'config') await phaseConfig();
  else if (phase === 'panels') await phasePanels();
  else if (phase === 'extras') await phaseExtras();
  else if (phase === 'show') { console.log(JSON.stringify(IDS, null, 2)); }
  else { console.log(`unknown/unimplemented phase: ${phase}`); }
} catch (e) {
  console.error('PHASE FAILED:', e.message);
  saveIds();
  await db.end();
  process.exit(1);
}
await db.end();
process.exit(0);
