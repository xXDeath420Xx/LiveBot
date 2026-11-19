/*
 * GreazySquad (1529358422368190585) — full server build, run by GreazyBot (1529358563233763338).
 * Streamer community for https://www.twitch.tv/greazyleo
 *
 *   node scripts/setup-greazysquad.mjs <phase>
 *     phases: preflight | roles | order | channels | config | panels | streaming | automod | show
 *
 * Idempotent: every entity keyed by a stable slug in scripts/.greazy-setup-ids.json.
 * All Discord ops are REST via the custom bot token (safe while PM2 runs — no gateway login).
 *
 * NOTE: this guild is a COMMUNITY server — #rules and the community-updates channel MUST stay
 * viewable by @everyone and cannot be age-restricted. Everything else is gated behind Verified.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD = '1529358422368190585';
const BOT_ROLE = '1529364089917276263';
const OWNER = '365905620060340224';
const TWITCH_LOGIN = 'greazyleo';
const TZ = 'America/New_York';
const IDS_PATH = new URL('./.greazy-setup-ids.json', import.meta.url);

// pre-existing channels (community server scaffolding)
const EX = {
  catText: '1529358423701983365', catVoice: '1529358423701983366',
  general: '1529358423701983367', voiceGeneral: '1529358424243179630',
  rules: '1529361062493945877', modOnly: '1529361062493945880',
};

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectTimeout: 8000,
});
// The acting bot comes from guild_bot_mapping — never pinned here.
const bot = await resolveBotForGuild(GUILD, { db });
const BOT_ID = bot.botId;
const TOKEN = bot.token;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asciiReason = (s) => String(s).replace(/[^\x20-\x7E]/g, '').slice(0, 300);

async function rest(method, path, body, reason) {
  const url = `https://discord.com/api/v10${path}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' };
    if (reason) headers['X-Audit-Log-Reason'] = asciiReason(reason);
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 20000);
    let res;
    try { res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ac.signal }); }
    catch (e) { clearTimeout(to); await sleep(600); continue; }
    clearTimeout(to);
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const wait = Math.ceil((j.retry_after || 1) * 1000) + 300;
      console.log(`  · 429 ${method} ${path} — wait ${wait}ms`); await sleep(wait); continue;
    }
    if (res.status >= 500) { await sleep(800); continue; }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return data;
  }
  throw new Error(`${method} ${path} -> exhausted retries`);
}

const IDS = existsSync(IDS_PATH) ? JSON.parse(readFileSync(IDS_PATH, 'utf8'))
  : { roles: {}, categories: {}, channels: {}, panels: {}, misc: {} };
const saveIds = () => writeFileSync(IDS_PATH, JSON.stringify(IDS, null, 2));
const R = (s) => IDS.roles[s];
const CH = (s) => IDS.channels[s];
const CAT = (s) => IDS.categories[s];

let guildRoles = [], guildChannels = [];
async function refresh() {
  guildRoles = await rest('GET', `/guilds/${GUILD}/roles`);
  guildChannels = await rest('GET', `/guilds/${GUILD}/channels`);
}

const C = {
  gold: 0xf1c40f, red: 0xe74c3c, orange: 0xe67e22, teal: 0x1abc9c, green: 0x2ecc71,
  blue: 0x3498db, purple: 0x9146ff, pink: 0xe91e63, grey: 0x95a5a6, navy: 0x2c3e50,
  lime: 0x7bed9f, sky: 0x5dade2, weed: 0x4caf50,
};

// ── ROLES ────────────────────────────────────────────────────────────────────
// top → bottom (position assigned in the `order` phase)
const STAFF_ROLES_DEF = [
  { slug: 'greazy', name: '👑 Greazy', color: C.gold, hoist: true },
  { slug: 'admin', name: '🛡️ Admin', color: C.red, hoist: true },
  { slug: 'mod', name: '⚔️ Moderator', color: C.orange, hoist: true },
  { slug: 'support', name: '🎧 Support', color: C.teal, hoist: true },
];
const FUNCTIONAL_ROLES = [
  { slug: 'live', name: '🔴 Live Now', color: C.purple, hoist: true },
  { slug: 'streamer', name: '🎥 Streamer', color: C.purple, hoist: false },
  { slug: 'twitch_vip', name: 'Twitch VIP', color: C.pink, hoist: false },
  { slug: 'twitch_mod', name: 'Twitch Mod', color: C.green, hoist: false },
  { slug: 'dj', name: '🎵 DJ', color: C.sky, hoist: false },
  { slug: 'verified', name: '✅ Verified', color: C.green, hoist: false },
  { slug: 'age18', name: '🔞 18+', color: C.red, hoist: false },
  { slug: 'age21', name: '🍺 21+', color: C.red, hoist: false },
  { slug: 'minigames', name: '🎮 Minigames', color: C.blue, hoist: false },
  { slug: 'freegames', name: '🎁 Free Games', color: C.lime, hoist: false },
  { slug: 'lounge420', name: '🌿 420 Club', color: C.weed, hoist: false },
  { slug: 'birthday', name: '🎂 Birthday', color: C.gold, hoist: false },
  { slug: 'unverified', name: '🚪 Unverified', color: C.grey, hoist: false },
];
const REACTION_PANELS = [
  { slug: 'access', name: '🔓 Access & Opt-Ins', mode: 'multiple', color: C.green,
    desc: 'Unlock the optional sections of the server. Toggle any of these on or off at any time.',
    roles: [['minigames', 'Minigames', '🎮'], ['freegames', 'Free Games Alerts', '🎁'], ['streamer', 'Streamer', '🎥']] },
  { slug: 'ping', name: '🔔 Ping Preferences', mode: 'multiple', color: C.sky,
    roles: [['ping_live', 'Greazy Live', '🔴'], ['ping_community', 'Community Lives', '📡'], ['ping_events', 'Events', '📅'], ['ping_announce', 'Announcements', '📢']] },
  { slug: 'platform', name: '🕹️ Platform', mode: 'multiple', color: C.navy,
    roles: [['plat_pc', 'PC', '🖥️'], ['plat_xbox', 'Xbox', '🟢'], ['plat_ps', 'PlayStation', '🔵'], ['plat_switch', 'Switch', '🔴'], ['plat_mobile', 'Mobile', '📱']] },
  { slug: 'region', name: '🌍 Region', mode: 'multiple', color: C.teal,
    roles: [['reg_na', 'North America', '🌎'], ['reg_sa', 'South America', '🌎'], ['reg_eu', 'Europe', '🌍'], ['reg_as', 'Asia', '🌏'], ['reg_oc', 'Oceania', '🌏'], ['reg_af', 'Africa', '🌍']] },
  { slug: 'pronouns', name: '💬 Pronouns', mode: 'multiple', color: C.pink,
    roles: [['pro_he', 'He/Him', '💙'], ['pro_she', 'She/Her', '💗'], ['pro_they', 'They/Them', '💜'], ['pro_ask', 'Ask Me', '💛']] },
];

function findRoleByName(name) { return guildRoles.find((r) => r.name === name); }
async function ensureRole(slug, name, color, hoist) {
  if (IDS.roles[slug]) {
    const ex = guildRoles.find((r) => r.id === IDS.roles[slug]);
    if (ex) {
      if (ex.name !== name || ex.color !== color) {
        await rest('PATCH', `/guilds/${GUILD}/roles/${ex.id}`, { name, color, hoist }, 'GreazySquad setup: normalize role');
        await sleep(300);
      }
      return ex.id;
    }
  }
  const byName = findRoleByName(name);
  if (byName) { IDS.roles[slug] = byName.id; return byName.id; }
  const created = await rest('POST', `/guilds/${GUILD}/roles`,
    { name, color, hoist, mentionable: false, permissions: '0' }, `GreazySquad setup: create ${name}`);
  IDS.roles[slug] = created.id; guildRoles.push(created); await sleep(340);
  return created.id;
}

async function phasePreflight() {
  await refresh();
  const me = await rest('GET', `/guilds/${GUILD}/members/${BOT_ID}`);
  const botRole = guildRoles.find((r) => r.id === BOT_ROLE);
  const perms = BigInt(botRole?.permissions || '0');
  const ADMIN = 1n << 3n;
  console.log(`bot role "${botRole?.name}" pos=${botRole?.position} admin=${(perms & ADMIN) === ADMIN}`);
  console.log(`bot member roles: ${JSON.stringify(me.roles)}`);
  const g = await rest('GET', `/guilds/${GUILD}`);
  console.log(`guild "${g.name}" community=${g.features.includes('COMMUNITY')} rules_ch=${g.rules_channel_id} updates_ch=${g.public_updates_channel_id}`);
  console.log(`roles=${guildRoles.length} channels=${guildChannels.length}`);
  if ((perms & ADMIN) !== ADMIN) console.log('\n⚠️  BOT LACKS ADMINISTRATOR — re-invite with admin or the build will fail.');
}

async function phaseRoles() {
  await refresh();
  console.log('— staff roles —');
  for (const r of STAFF_ROLES_DEF) { console.log(`  ${r.name.padEnd(18)} ${await ensureRole(r.slug, r.name, r.color, r.hoist)}`); saveIds(); }
  console.log('— functional roles —');
  for (const r of FUNCTIONAL_ROLES) { console.log(`  ${r.name.padEnd(18)} ${await ensureRole(r.slug, r.name, r.color, r.hoist)}`); saveIds(); }
  console.log('— reaction-role roles —');
  for (const p of REACTION_PANELS) {
    for (const [slug, name] of p.roles) { console.log(`  [${p.slug}] ${name.padEnd(16)} ${await ensureRole(slug, name, p.color, false)}`); saveIds(); }
  }
  saveIds();
  console.log(`\n${Object.keys(IDS.roles).length} roles tracked.`);
}

// order roles so staff sit at the top, just under the bot
async function phaseOrder() {
  await refresh();
  const desired = [...STAFF_ROLES_DEF, ...FUNCTIONAL_ROLES].map((r) => R(r.slug)).filter(Boolean);
  const rrRoles = REACTION_PANELS.flatMap((p) => p.roles.map(([s]) => R(s))).filter(Boolean);
  const ordered = [...desired, ...rrRoles]; // top → bottom
  // assign descending positions starting just below the bot role
  const n = ordered.length;
  const payload = ordered.map((id, i) => ({ id, position: n - i }));
  await rest('PATCH', `/guilds/${GUILD}/roles`, payload, 'GreazySquad setup: role hierarchy');
  console.log(`reordered ${n} roles below ${BOT_ROLE}`);
}

// ── CHANNELS ─────────────────────────────────────────────────────────────────
const B = {
  VIEW: 1n << 10n, SEND: 1n << 11n, HISTORY: 1n << 16n, ADDREACT: 1n << 6n,
  EMBED: 1n << 14n, ATTACH: 1n << 15n, EXTEMOJI: 1n << 18n, APPCMDS: 1n << 31n,
  CONNECT: 1n << 20n, SPEAK: 1n << 21n, USEVAD: 1n << 25n, VIDEO: 1n << 9n, STREAM: 1n << 9n,
  MANAGE_MSG: 1n << 13n, MENTION_EVERYONE: 1n << 17n, CREATE_THREAD: 1n << 34n, SEND_THREAD: 1n << 38n,
};
const TEXT_MEMBER = B.VIEW | B.SEND | B.HISTORY | B.ADDREACT | B.EMBED | B.ATTACH | B.EXTEMOJI | B.APPCMDS | B.CREATE_THREAD | B.SEND_THREAD;
const VOICE_MEMBER = B.VIEW | B.CONNECT | B.SPEAK | B.USEVAD | B.VIDEO;
const RO_ALLOW = B.VIEW | B.HISTORY;
const RO_DENY = B.SEND | B.ADDREACT | B.CREATE_THREAD | B.SEND_THREAD;
const ow = (id, allow, deny) => ({ id, type: 0, allow: String(allow), deny: String(deny) });
const EVERYONE = GUILD;

function staffOw(extra = 0n) {
  return ['admin', 'mod'].map((s) => ow(R(s), TEXT_MEMBER | B.MANAGE_MSG | extra, 0n));
}

function categoryDefs() {
  const v = R('verified'), a18 = R('age18'), mg = R('minigames');
  return [
    { slug: 'info', name: '📋 INFORMATION', ow: [ow(EVERYONE, RO_ALLOW, RO_DENY), ...staffOw()] },
    { slug: 'live', name: '🔴 LIVE & STREAMS', ow: [ow(EVERYONE, 0n, B.VIEW), ow(v, RO_ALLOW, RO_DENY), ...staffOw()] },
    { slug: 'community', name: '💬 COMMUNITY', ow: [ow(EVERYONE, 0n, B.VIEW), ow(v, TEXT_MEMBER, 0n), ...staffOw()] },
    { slug: 'memes', name: '😂 MEMES', ow: [ow(EVERYONE, 0n, B.VIEW), ow(v, TEXT_MEMBER, 0n), ...staffOw()] },
    { slug: 'lounge420', name: '🌿 420 LOUNGE', ow: [ow(EVERYONE, 0n, B.VIEW), ow(a18, TEXT_MEMBER | VOICE_MEMBER, 0n), ...staffOw()] },
    { slug: 'games', name: '🎮 MINIGAMES', ow: [ow(EVERYONE, 0n, B.VIEW), ow(mg, TEXT_MEMBER, 0n), ...staffOw()] },
    { slug: 'music', name: '🎵 MUSIC', ow: [ow(EVERYONE, 0n, B.VIEW), ow(v, TEXT_MEMBER | VOICE_MEMBER, 0n), ...staffOw()] },
    { slug: 'voice', name: '🔊 VOICE', ow: [ow(EVERYONE, 0n, B.VIEW), ow(v, VOICE_MEMBER, 0n), ...staffOw()] },
    { slug: 'support', name: '🎫 SUPPORT', ow: [ow(EVERYONE, 0n, B.VIEW), ow(v, RO_ALLOW, RO_DENY), ...staffOw()] },
    { slug: 'tickets', name: '📨 TICKETS', ow: [ow(EVERYONE, 0n, B.VIEW), ...staffOw(), ow(R('support'), TEXT_MEMBER, 0n)] },
    { slug: 'stats', name: '📊 SERVER STATS', ow: [ow(EVERYONE, B.VIEW, B.CONNECT)] },
    { slug: 'staff', name: '🛠️ STAFF', ow: [ow(EVERYONE, 0n, B.VIEW), ...staffOw(), ow(R('support'), TEXT_MEMBER, 0n)] },
  ];
}

// [slug, name, type, catSlug, existingId|null, owOverride|null, nsfw]
function channelDefs() {
  const v = R('verified'), mg = R('minigames'), a18 = R('age18');
  const readOnlyMember = [ow(EVERYONE, 0n, B.VIEW), ow(v, RO_ALLOW, RO_DENY), ...staffOw()];
  const postable = [ow(EVERYONE, 0n, B.VIEW), ow(v, TEXT_MEMBER, 0n), ...staffOw()];
  const publicRO = [ow(EVERYONE, RO_ALLOW, RO_DENY), ...staffOw()];
  return [
    // INFORMATION (public — community server requires #rules visible)
    ['welcome', 'welcome', 0, 'info', null, publicRO, false],
    ['rules', 'rules', 0, 'info', EX.rules, publicRO, false],
    ['announcements', 'announcements', 0, 'info', null, publicRO, false],
    ['getroles', 'get-roles', 0, 'info', null, [ow(EVERYONE, RO_ALLOW, RO_DENY), ...staffOw()], false],
    // LIVE & STREAMS
    ['greazylive', 'greazy-live', 0, 'live', null, readOnlyMember, false],
    ['communitylive', 'community-live', 0, 'live', null, readOnlyMember, false],
    ['selfpromo', 'self-promo', 0, 'live', null, postable, false],
    ['streamsignup', 'stream-signup', 0, 'live', null, readOnlyMember, false],
    ['clips', 'clips-and-highlights', 0, 'live', null, postable, false],
    // COMMUNITY
    ['general', 'general', 0, 'community', EX.general, postable, false],
    ['media', 'media', 0, 'community', null, postable, false],
    ['suggestions', 'suggestions', 0, 'community', null, postable, false],
    ['birthdays', 'birthdays', 0, 'community', null, readOnlyMember, false],
    ['levelup', 'level-up', 0, 'community', null, readOnlyMember, false],
    ['freegames', 'free-games', 0, 'community', null, readOnlyMember, false],
    // MEMES
    ['memes', 'memes', 0, 'memes', null, postable, false],
    ['shitposting', 'shitposting', 0, 'memes', null, postable, false],
    // 420 (age gated + NSFW)
    ['sesh', 'the-sesh', 0, 'lounge420', null, null, true],
    ['stashpics', 'stash-pics', 0, 'lounge420', null, null, true],
    ['vc420', '🌿 420 Lounge', 2, 'lounge420', null, null, true],
    // MINIGAMES (opt-in role)
    ['botcmds', 'bot-commands', 0, 'games', null, null, false],
    ['fishing', 'fishing', 0, 'games', null, null, false],
    ['pokemon', 'pokemon', 0, 'games', null, null, false],
    ['cah', 'cards-against-humanity', 0, 'games', null, null, true],
    ['trivia', 'trivia', 0, 'games', null, null, false],
    // MUSIC
    ['musicreq', 'music-requests', 0, 'music', null, null, false],
    ['vcmusic', '🎵 Music Lounge', 2, 'music', null, null, false],
    // VOICE
    ['vccreate', '➕ Join to Create', 2, 'voice', null, null, false],
    ['vcgeneral', 'General', 2, 'voice', EX.voiceGeneral, null, false],
    ['vcafk', '💤 AFK', 2, 'voice', null, null, false],
    // SUPPORT
    ['support', 'support', 0, 'support', null, readOnlyMember, false],
    // STATS
    ['statmembers', '👤 | loading…', 2, 'stats', null, null, false],
    ['stattime', '🕐 | loading…', 2, 'stats', null, null, false],
    // STAFF
    ['staffchat', 'staff-chat', 0, 'staff', null, null, false],
    ['modlog', 'mod-log', 0, 'staff', null, null, false],
    ['modalerts', 'mod-alerts', 0, 'staff', null, null, false],
  ];
}

async function ensureCategory(def, position) {
  let id = IDS.categories[def.slug];
  let cur = id ? guildChannels.find((c) => c.id === id) : guildChannels.find((c) => c.type === 4 && c.name === def.name);
  if (cur) {
    id = cur.id;
    await rest('PATCH', `/channels/${id}`, { name: def.name, position, permission_overwrites: def.ow }, 'GreazySquad setup: category');
  } else {
    const created = await rest('POST', `/guilds/${GUILD}/channels`, { name: def.name, type: 4, position, permission_overwrites: def.ow }, 'GreazySquad setup: create category');
    id = created.id; guildChannels.push(created);
  }
  IDS.categories[def.slug] = id; saveIds(); await sleep(400);
  return id;
}

async function ensureChannel([slug, name, type, catSlug, existingId, owOverride, nsfw], position, catOw) {
  const parent_id = IDS.categories[catSlug];
  const overwrites = owOverride || catOw;
  let id = IDS.channels[slug] || existingId;
  let cur = id ? guildChannels.find((c) => c.id === id) : guildChannels.find((c) => c.name === name && c.parent_id === parent_id);
  const body = { parent_id, position, permission_overwrites: overwrites };
  if (nsfw) body.nsfw = true; // text AND voice channels support age-restriction
  if (cur) {
    id = cur.id;
    await rest('PATCH', `/channels/${id}`, body, 'GreazySquad setup: place channel');
  } else {
    const created = await rest('POST', `/guilds/${GUILD}/channels`, { name, type, ...body }, 'GreazySquad setup: create channel');
    id = created.id; guildChannels.push(created);
  }
  IDS.channels[slug] = id; saveIds(); await sleep(400);
  return id;
}

async function phaseChannels() {
  await refresh();
  const everyoneRole = guildRoles.find((r) => r.id === EVERYONE);
  const cur = BigInt(everyoneRole.permissions);
  if (cur & B.MENTION_EVERYONE) {
    await rest('PATCH', `/guilds/${GUILD}/roles/${EVERYONE}`, { permissions: String(cur & ~B.MENTION_EVERYONE) }, 'GreazySquad: harden everyone');
    console.log('· removed MENTION_EVERYONE from @everyone'); await sleep(320);
  }
  const cats = categoryDefs(); const catOw = {}; let pos = 0;
  for (const d of cats) { const id = await ensureCategory(d, pos++); catOw[d.slug] = d.ow; console.log(`▼ ${d.name.padEnd(22)} ${id}`); }
  const defs = channelDefs(); const perCat = {};
  for (const d of defs) (perCat[d[3]] ||= []).push(d);
  for (const cs of Object.keys(perCat)) {
    let cp = 0;
    for (const d of perCat[cs]) console.log(`   #${d[1].padEnd(24)} ${await ensureChannel(d, cp++, catOw[cs])}`);
  }
  // tuck the two default categories to the bottom
  for (const [i, cid] of [EX.catText, EX.catVoice].entries()) {
    if (guildChannels.find((c) => c.id === cid)) {
      await rest('PATCH', `/channels/${cid}`, { position: 90 + i }, 'GreazySquad: demote default category').catch(() => {});
      await sleep(300);
    }
  }
  saveIds();
  console.log(`\n${Object.keys(IDS.channels).length} channels, ${Object.keys(IDS.categories).length} categories.`);
}

// ── CONFIG ───────────────────────────────────────────────────────────────────
async function up(table, cols) {
  const keys = Object.keys(cols);
  const sql = `INSERT INTO \`${table}\` (guild_id, ${keys.map((k) => `\`${k}\``).join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})
               ON DUPLICATE KEY UPDATE ${keys.map((k) => `\`${k}\`=VALUES(\`${k}\`)`).join(',')}`;
  await db.query(sql, [GUILD, ...keys.map((k) => cols[k])]);
  console.log(`  ${table}: set`);
}

const LOG_EVENTS = ['ban', 'unban', 'memberKick', 'memberJoin', 'memberLeave', 'memberUpdate',
  'messageDelete', 'messageUpdate', 'channelCreate', 'channelDelete', 'channelUpdate',
  'roleCreate', 'roleDelete', 'roleUpdate', 'guildUpdate', 'inviteCreate', 'inviteDelete',
  'threadCreate', 'threadDelete', 'webhookUpdate'];
// deliberately excluded: emoji*/sticker*/soundboard* (hard-blocked in log-manager anyway),
// voiceUpdate + threadUpdate + integrationUpdate (spam)
const DISABLED_CMDS = ['arcade', 'cat', 'counting', 'luck', 'owo', 'owo2', 'owoify', 'rpg', 'tarot', 'tree', 'wordgame'];

async function phaseConfig() {
  console.log('— onboarding —');
  await up('verify_config', { verified_role_id: R('verified'), unverified_role_id: R('unverified'), gate_channel_id: CH('rules'), enabled: 1 });
  await up('welcome_settings', {
    channel_id: CH('welcome'), auto_role_id: R('unverified'),
    message: `Welcome to **GreazySquad**, {user}! 🔥\nHead to <#${CH('rules')}> to verify (18+ only), then grab your roles in <#${CH('getroles')}>.`,
    goodbye_enabled: 1, goodbye_channel_id: CH('welcome'),
    card_title_text: 'Welcome, {user}!', card_subtitle_text: 'You made it to {server}',
  });
  await up('autoroles_config', { is_enabled: 1, roles_to_assign: JSON.stringify([R('unverified')]) });

  console.log('— protection —');
  await up('anti_nuke_config', { enabled: 1, max_channel_deletes: 3, max_role_deletes: 3, max_kick_bans: 5, action_on_trigger: 'remove_roles', alert_channel_id: CH('modalerts') });
  await up('raid_detection_config', { enabled: 1, join_threshold: 8, join_timeframe_seconds: 60, new_account_age_hours: 72, new_account_ratio: 0.60, action: 'lockdown', alert_channel_id: CH('modalerts'), mute_duration_minutes: 30, purge_messages: 0 });
  // action ENUM is delete|warn|mute|kick|ban — 'mute' also removes the offending message
  await up('phishing_config', { enabled: 1, action: 'mute', mute_duration_minutes: 60, alert_channel_id: CH('modalerts'), report_channel_id: CH('modalerts'), log_detections: 1, scan_images: 1 });

  console.log('— logging (no emoji/sticker/voice spam) —');
  await up('logging_config', { log_channel_id: CH('modlog'), enabled: 1, enabled_events: JSON.stringify(LOG_EVENTS) });
  await db.query('DELETE FROM log_event_config WHERE guild_id=?', [GUILD]);
  for (const ev of LOG_EVENTS) {
    await db.query('INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id) VALUES (?,?,1,?)', [GUILD, ev, CH('modlog')]);
  }
  console.log(`  log_event_config: ${LOG_EVENTS.length} events enabled`);

  console.log('— engagement —');
  await up('level_config', { enabled: 1, level_up_channel_id: CH('levelup'), xp_per_message: 15, xp_cooldown_seconds: 60, voice_xp_enabled: 1, xp_per_voice_minute: 5 });
  await up('guild_settings', { timezone: TZ });
  await db.query('INSERT INTO tz_guild_config (guild_id, time_zone) VALUES (?,?) ON DUPLICATE KEY UPDATE time_zone=VALUES(time_zone)', [GUILD, TZ]).catch((e) => console.log('  tz_guild_config:', e.message));

  console.log('— voice / music —');
  await up('temp_channel_config', { creator_channel_id: CH('vccreate'), category_id: CAT('voice'), naming_template: "{user}'s VC", default_user_limit: 0 });
  // NOTE: deliberately NOT setting default_voice_channel_id — that is the 24/7 "camp" channel and
  // making the bot sit in voice is an opt-in the owner turns on with /music 247, not a build default.
  await up('music_config', { is_enabled: 1, enabled: 1, dj_role_id: R('dj'), dj_enabled: 1, request_channel_id: CH('musicreq'), default_volume: 50, vote_skip_enabled: 1, vote_skip_percentage: 50 });

  console.log('— minigames (allowed only) —');
  await up('cah_guild_config', { nsfw_allowed: 1, blank_cards_allowed: 1, max_blank_cards: 3, default_points: 5, default_max_rounds: 10, default_timeout_secs: 120 });
  // spawn rates are probabilities, decimal(4,3) — matches the fleet-wide default
  await up('pokemon_settings', { pokemon_channel_id: CH('pokemon'), spawn_enabled: 1, min_spawn_rate: 0.050, max_spawn_rate: 0.250, activity_tracking_enabled: 1 });

  console.log('— command restrictions —');
  await db.query('DELETE FROM guild_command_restrictions WHERE guild_id=?', [GUILD]);
  for (const c of DISABLED_CMDS) {
    await db.query('INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only) VALUES (?,?,0,0)', [GUILD, c]);
  }
  const pinned = [['fish', CH('fishing')], ['pokemon', CH('pokemon')], ['cah', CH('cah')], ['trivia', CH('trivia')], ['cannabis', CH('sesh')]];
  for (const [cmd, ch] of pinned) {
    await db.query('INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only, channel_id) VALUES (?,?,1,0,?)', [GUILD, cmd, ch]);
  }
  console.log(`  ${DISABLED_CMDS.length} disabled, ${pinned.length} channel-pinned`);

  console.log('— stats —');
  await db.query('DELETE FROM stat_display_channels WHERE guild_id=?', [GUILD]);
  await db.query('INSERT INTO stat_display_channels (guild_id, channel_id, stat_type, template) VALUES (?,?,?,?)', [GUILD, CH('statmembers'), 'members', '👤 | {value}']);
  await db.query('INSERT INTO stat_display_channels (guild_id, channel_id, stat_type, template) VALUES (?,?,?,?)', [GUILD, CH('stattime'), 'time', '🕐 | {value}']);
  console.log('  stat_display_channels: 2');

  console.log('\nConfig phase done.');
}

// ── PANELS ───────────────────────────────────────────────────────────────────
const hex = (n) => '#' + n.toString(16).padStart(6, '0').toUpperCase();
async function post(ch, payload) { const m = await rest('POST', `/channels/${ch}/messages`, payload, null); await sleep(450); return m; }
function buttonRows(items, style = 2) {
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push({ type: 1, components: items.slice(i, i + 5).map(([cid, label, emoji]) => ({ type: 2, style, label, custom_id: cid, ...(emoji ? { emoji: { name: emoji } } : {}) })) });
  }
  return rows;
}
const AGE_PANEL = {
  slug: 'age', name: '🔞 Age Verification', mode: 'multiple', color: C.red,
  desc: 'This is an **18+ server**. Confirm your age to unlock the 🌿 420 Lounge and other age-restricted areas.\n\nBy clicking you attest that you meet the age requirement. Lying here is a bannable offence.',
  roles: [['age18', 'I am 18+', '🔞'], ['age21', 'I am 21+', '🍺']],
};

async function phasePanels() {
  await refresh();
  // rules + verify gate
  if (!IDS.panels.verify) {
    const embed = {
      title: '🔥 Welcome to GreazySquad',
      color: C.gold,
      description: [
        `The home of **[greazyleo](https://www.twitch.tv/${TWITCH_LOGIN})** and the squad.`,
        '',
        '**⚠️ This is an 18+ server.** By verifying you confirm you are at least 18 years old.',
        '',
        '**The Rules**',
        '**1.** Be respectful. No harassment, hate speech, racism, or bigotry — zero tolerance.',
        '**2.** No NSFW outside the age-gated channels. No gore, no illegal content.',
        '**3.** No spam, no DM advertising, no unsolicited self-promo outside <#' + CH('selfpromo') + '>.',
        '**4.** No drama, witch-hunting, or starting shit with other communities.',
        '**5.** Keep it legal and follow the [Discord ToS](https://discord.com/terms).',
        '**6.** Staff have final say. Listen to them.',
        '',
        'Click **I Agree** to unlock the server.',
      ].join('\n'),
      footer: { text: 'GreazySquad • verify to continue' },
    };
    const row = { type: 1, components: [{ type: 2, style: 3, label: 'I Agree — Verify Me', custom_id: 'verify_accept', emoji: { name: '✅' } }] };
    const msg = await post(CH('rules'), { embeds: [embed], components: [row] });
    await db.query('UPDATE verify_config SET gate_message_id=? WHERE guild_id=?', [msg.id, GUILD]);
    IDS.panels.verify = msg.id; saveIds();
    console.log(`  verify gate posted ${msg.id}`);
  } else console.log('  verify gate: already posted');

  // reaction role panels
  for (const p of [AGE_PANEL, ...REACTION_PANELS]) {
    if (IDS.panels[p.slug]) { console.log(`  panel ${p.slug}: exists`); continue; }
    const items = p.roles.map(([slug, label, emoji]) => [`rr_${R(slug)}`, label, emoji]);
    const desc = p.desc || `Pick your **${p.name.replace(/^[^\s]+\s/, '')}** role${p.mode === 'unique' ? ' (one only)' : 's'} below.`;
    const embed = { title: p.name, color: p.color, description: desc };
    const msg = await post(CH('getroles'), { embeds: [embed], components: buttonRows(items) });
    const [ins] = await db.query(
      `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
       VALUES (?,?,?,?,?,?,'button',?)`,
      [GUILD, CH('getroles'), msg.id, p.name, desc, hex(p.color), p.mode]);
    for (const [slug, label, emoji] of p.roles) {
      await db.query('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?,?,?,?,2)', [ins.insertId, R(slug), emoji, label]);
    }
    IDS.panels[p.slug] = msg.id; saveIds();
    console.log(`  panel ${p.slug}: ${msg.id} (${p.roles.length} roles)`);
  }

  // ticket panel
  if (!IDS.panels.ticket) {
    const [ins] = await db.query(
      `INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color, button_text, button_emoji, ticket_category_id, support_role_id, ticket_name_format, save_transcripts, log_channel_id, alert_channel_id, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,1)`,
      [GUILD, 'Support', CH('support'), '🎫 Need a hand?', 'Open a private ticket and staff will get back to you.', hex(C.teal), 'Open a Ticket', '🎫', CAT('tickets'), R('support'), 'ticket-{username}', CH('modlog'), CH('modalerts')]);
    const embed = { title: '🎫 Need a hand?', color: C.teal, description: 'Questions, reports, or business enquiries — open a private ticket and staff will get back to you.' };
    const row = { type: 1, components: [{ type: 2, style: 1, label: 'Open a Ticket', custom_id: `ticket_create_panel_${ins.insertId}`, emoji: { name: '🎫' } }] };
    const msg = await post(CH('support'), { embeds: [embed], components: [row] });
    await db.query('UPDATE ticket_panels SET panel_message_id=? WHERE panel_id=?', [msg.id, ins.insertId]);
    IDS.panels.ticket = msg.id; saveIds();
    console.log(`  ticket panel: ${msg.id}`);
  } else console.log('  ticket panel: exists');

  // music panel
  if (!IDS.panels.music) {
    const embed = { title: '🎵 Music Player', color: C.sky, description: `Queue tracks with **/music play** in <#${CH('musicreq')}>.\nThe player joins <#${CH('vcmusic')}>.` };
    const msg = await post(CH('musicreq'), { embeds: [embed] });
    await db.query('INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), message_id=VALUES(message_id)', [GUILD, CH('musicreq'), msg.id]);
    IDS.panels.music = msg.id; saveIds();
    console.log(`  music panel: ${msg.id}`);
  } else console.log('  music panel: exists');

  console.log('\nPanels phase done.');
}

// ── STREAMING ────────────────────────────────────────────────────────────────
const PLATFORMS = ['twitch', 'kick', 'youtube', 'tiktok', 'rumble'];
const GREAZY_MSG = [
  '## 🔴 {streamer} is LIVE — {game}',
  '',
  '-# The squad has been summoned. Pull up.',
  '',
  '**{title}**',
  '',
  '▶️ {url}',
].join('\n');

async function phaseStreaming() {
  await refresh();
  // 1) resolve greazyleo on Twitch and create the streamer row
  const { getTwitchUser } = await import('../utils/platforms/twitch-api.js');
  const tu = await getTwitchUser(TWITCH_LOGIN).catch((e) => { console.log('  twitch lookup failed:', e.message); return null; });
  if (!tu?.id) throw new Error(`could not resolve twitch user ${TWITCH_LOGIN}`);
  console.log(`· twitch: ${tu.display_name || tu.login} id=${tu.id}`);
  let [[st]] = await db.query("SELECT streamer_id FROM streamers WHERE platform='twitch' AND platform_user_id=?", [String(tu.id)]);
  if (!st) {
    const [ins] = await db.query(
      'INSERT INTO streamers (platform, platform_user_id, username, normalized_username, profile_image_url) VALUES (?,?,?,?,?)',
      ['twitch', String(tu.id), tu.login, tu.login.toLowerCase(), tu.profile_image_url || null]);
    st = { streamer_id: ins.insertId };
    console.log(`  created streamer #${st.streamer_id}`);
  } else console.log(`  streamer exists #${st.streamer_id}`);
  IDS.misc.streamerId = st.streamer_id; saveIds();

  // 2) greazyleo gets his OWN announcement channel, separate from everyone else
  const [[sub]] = await db.query('SELECT subscription_id FROM subscriptions WHERE guild_id=? AND streamer_id=?', [GUILD, st.streamer_id]);
  if (sub) {
    await db.query('UPDATE subscriptions SET announcement_channel_id=?, live_role_id=?, ping_role_id=?, custom_message=?, paused=0 WHERE subscription_id=?',
      [CH('greazylive'), R('live'), R('ping_live'), GREAZY_MSG, sub.subscription_id]);
    console.log(`  subscription #${sub.subscription_id} -> #greazy-live (updated)`);
  } else {
    const [ins] = await db.query(
      'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, live_role_id, ping_role_id, custom_message, edit_on_end, paused) VALUES (?,?,?,?,?,?,1,0)',
      [GUILD, st.streamer_id, CH('greazylive'), R('live'), R('ping_live'), GREAZY_MSG]);
    console.log(`  subscription #${ins.insertId} -> #greazy-live (created)`);
  }

  // 3) everyone ELSE announces in #community-live
  await up('self_promo_config', {
    enabled: 1, channel_id: CH('selfpromo'), auto_subscribe: 1,
    announcement_channel_id: CH('communitylive'), same_channel: 0,
    allowed_platforms: JSON.stringify(PLATFORMS),
    delete_invalid: 0, keep_message: 1, dm_on_track: 1,
  });
  await db.query('DELETE FROM guild_streamer_auto_track WHERE guild_id=?', [GUILD]);
  await db.query(
    'INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, live_role_id, min_level, enabled, delete_on_end, edit_on_end) VALUES (?,?,?,?,0,1,0,1)',
    [GUILD, R('streamer'), CH('communitylive'), R('live')]);
  console.log('  guild_streamer_auto_track: Streamer role -> #community-live');

  // 4) free games feed + opt-in ping role
  await db.query('DELETE FROM free_games_subscriptions WHERE guild_id=?', [GUILD]);
  await db.query(
    `INSERT INTO free_games_subscriptions
      (guild_id, discord_channel_id, mention_role_id, notify_free, notify_weekend, notify_dlc, notify_prime, notify_gamepass,
       filter_steam, filter_epic, filter_gog, filter_humble, filter_origin, filter_ubisoft, filter_itch, filter_prime,
       filter_windows, filter_mac, filter_linux, is_enabled)
     VALUES (?,?,?,1,1,1,1,1, 1,1,1,1,1,1,1,1, 1,1,1, 1)`,
    [GUILD, CH('freegames'), R('freegames')]);
  console.log('  free_games_subscriptions: #free-games + Free Games role');

  // 5) self-promo signup panel — routes signups to #community-live
  if (!IDS.panels.signup) {
    const embed = {
      title: '🎥 Get Your Streams Announced',
      color: C.purple,
      description: [
        'Stream on Twitch, Kick, YouTube, TikTok or Rumble? Get the bot to announce you automatically.',
        '',
        `**1.** Click **Add Me** below and drop your channel link.`,
        `**2.** You'll get the 🎥 Streamer role.`,
        `**3.** Every time you go live it posts in <#${CH('communitylive')}>.`,
        '',
        `You can also just paste your link in <#${CH('selfpromo')}> and the bot will pick it up.`,
      ].join('\n'),
    };
    const row = { type: 1, components: [{ type: 2, style: 3, label: 'Add Me', custom_id: `selfpromo_join:${CH('communitylive')}`, emoji: { name: '🎥' } }] };
    const msg = await post(CH('streamsignup'), { embeds: [embed], components: [row] });
    IDS.panels.signup = msg.id; saveIds();
    console.log(`  signup panel: ${msg.id}`);
  } else console.log('  signup panel: exists');

  console.log('\nStreaming phase done. EventSub picks greazyleo up on the next reconcile (<=30 min).');
}

// ── AUTOMOD ──────────────────────────────────────────────────────────────────
async function phaseAutomod() {
  await refresh();
  const existing = await rest('GET', `/guilds/${GUILD}/auto-moderation/rules`).catch(() => []);
  const have = new Set((Array.isArray(existing) ? existing : []).map((r) => r.name));
  const alert = { type: 2, metadata: { channel_id: CH('modalerts') } };
  const block = { type: 1, metadata: { custom_message: 'Blocked by GreazySquad AutoMod.' } };
  const exempt = [R('admin'), R('mod')].filter(Boolean);
  const rules = [
    { name: 'Greazy • Spam', event_type: 1, trigger_type: 3, actions: [block, alert] },
    { name: 'Greazy • Mention Spam', event_type: 1, trigger_type: 5, trigger_metadata: { mention_total_limit: 6 }, actions: [block, alert] },
    { name: 'Greazy • Slurs', event_type: 1, trigger_type: 4, trigger_metadata: { presets: [3] }, actions: [block, alert] },
    { name: 'Greazy • Invite Links', event_type: 1, trigger_type: 1, trigger_metadata: { regex_patterns: ['(discord\\.(gg|io|me|li)|discordapp\\.com/invite)/[a-zA-Z0-9]+'] }, actions: [block, alert] },
  ];
  for (const r of rules) {
    if (have.has(r.name)) { console.log(`· ${r.name}: exists`); continue; }
    await rest('POST', `/guilds/${GUILD}/auto-moderation/rules`, { ...r, enabled: true, exempt_roles: exempt }, 'GreazySquad: automod');
    console.log(`· ${r.name}: created`); await sleep(450);
  }
  console.log('\nAutomod phase done.');
}

// ── MODERATION / GLOBAL BAN / BIRTHDAYS / AUTO-PUBLISHER ─────────────────────
async function phaseModeration() {
  await refresh();
  // 1) Muted role + a deny overwrite on every channel (single-overwrite PUT so we
  //    never clobber the existing per-channel permission sets)
  const muted = await ensureRole('muted', '🔇 Muted', 0x546e7a, false);
  saveIds();
  console.log(`· Muted role ${muted}`);
  const denyText = B.SEND | B.ADDREACT | B.CREATE_THREAD | B.SEND_THREAD;
  const denyVoice = B.SPEAK | B.STREAM;
  let n = 0;
  for (const c of guildChannels) {
    if (![0, 2, 4, 5].includes(c.type)) continue;
    const deny = c.type === 2 ? (denyText | denyVoice) : denyText;
    try {
      await rest('PUT', `/channels/${c.id}/permissions/${muted}`, { type: 0, allow: '0', deny: String(deny) }, 'GreazySquad: muted role');
      n++;
    } catch (e) { console.log(`  ! ${c.name}: ${e.message.slice(0, 60)}`); }
    await sleep(330);
  }
  console.log(`· Muted deny applied to ${n} channels`);

  // 2) moderation tools
  await up('moderation_config', { mod_log_channel_id: CH('modlog'), muted_role_id: muted });

  // 3) global ban network — staff exempt, alerts to #mod-alerts
  const exempt = JSON.stringify([R('greazy'), R('admin'), R('mod')].filter(Boolean));
  await up('global_ban_config', {
    enabled: 1, action_critical: 'ban', action_high: 'ban', action_medium: 'kick', action_low: 'alert',
    alert_channel_id: CH('modalerts'), log_actions: 1, check_on_join: 1, check_on_message: 0,
    auto_aggregate_opt_in: 1, exempt_roles: exempt,
  });

  // 4) birthdays
  await up('birthday_config', {
    announcement_channel_id: CH('birthdays'), enabled: 1, birthday_role_id: R('birthday'),
    message_template: '🎂 Happy birthday, {mention}! The whole squad hopes you have a great one.',
    card_channel_id: CH('birthdays'), cards_enabled: 1, default_card_type: 'board',
  });

  // 5) auto publisher — only fires in GuildAnnouncement channels, so convert #announcements
  const ann = guildChannels.find((c) => c.id === CH('announcements'));
  if (ann && ann.type !== 5) {
    await rest('PATCH', `/channels/${CH('announcements')}`, { type: 5 }, 'GreazySquad: announcement channel');
    console.log('· #announcements converted to an Announcement channel');
    await sleep(400);
  } else console.log(`· #announcements already type ${ann?.type}`);
  await up('auto_publisher_config', { is_enabled: 1 });

  console.log('\nModeration phase done.');
}

// ── FINALIZE ─────────────────────────────────────────────────────────────────
async function phaseFinalize() {
  await refresh();
  // community-updates channel ("moderator-only") belongs with STAFF
  if (guildChannels.find((c) => c.id === EX.modOnly)) {
    await rest('PATCH', `/channels/${EX.modOnly}`, { parent_id: CAT('staff'), position: 9 }, 'GreazySquad: tidy updates channel').catch((e) => console.log('  modOnly move:', e.message));
    console.log('· #moderator-only -> STAFF category');
    await sleep(350);
  }
  // guild-level: AFK channel, system channel, safety
  await rest('PATCH', `/guilds/${GUILD}`, {
    afk_channel_id: CH('vcafk'), afk_timeout: 900,
    system_channel_id: CH('welcome'),
    explicit_content_filter: 2,
    default_message_notifications: 1, // mentions only
  }, 'GreazySquad: guild settings');
  console.log('· guild: AFK=#AFK, system=#welcome, explicit filter=all members, notifications=mentions');
  await sleep(400);
  // make sure the age-gated channels really are age-restricted
  for (const slug of ['sesh', 'stashpics', 'vc420', 'cah']) {
    if (!CH(slug)) continue;
    await rest('PATCH', `/channels/${CH(slug)}`, { nsfw: true }, 'GreazySquad: age restrict').catch((e) => console.log(`  nsfw ${slug}:`, e.message));
    await sleep(320);
  }
  console.log('· age-restricted: #the-sesh, #stash-pics, 420 Lounge VC, #cards-against-humanity');
  console.log('\nFinalize phase done.');
}

async function phaseVerify() {
  await refresh();
  const problems = [];
  const [[vc]] = await db.query('SELECT * FROM verify_config WHERE guild_id=?', [GUILD]);
  console.log(`verify_config: role=${vc?.verified_role_id} gate_msg=${vc?.gate_message_id} enabled=${vc?.enabled}`);
  if (!vc?.gate_message_id) problems.push('verify gate message id missing');
  const [[lg]] = await db.query('SELECT * FROM logging_config WHERE guild_id=?', [GUILD]);
  const [[lc]] = await db.query('SELECT COUNT(*) n FROM log_event_config WHERE guild_id=? AND enabled=1', [GUILD]);
  console.log(`logging: channel=${lg?.log_channel_id} enabled=${lg?.enabled} events=${lc.n}`);
  const [[sp]] = await db.query('SELECT * FROM self_promo_config WHERE guild_id=?', [GUILD]);
  console.log(`self_promo: enabled=${sp?.enabled} in=${sp?.channel_id} announce=${sp?.announcement_channel_id} auto=${sp?.auto_subscribe}`);
  const [subs] = await db.query('SELECT sub.subscription_id, s.username, sub.announcement_channel_id, sub.paused FROM subscriptions sub JOIN streamers s ON sub.streamer_id=s.streamer_id WHERE sub.guild_id=?', [GUILD]);
  console.log(`subscriptions: ${JSON.stringify(subs)}`);
  const [[at]] = await db.query('SELECT * FROM guild_streamer_auto_track WHERE guild_id=?', [GUILD]);
  console.log(`auto_track: role=${at?.role_id} -> ${at?.announcement_channel_id} live=${at?.live_role_id}`);
  const [[fg]] = await db.query('SELECT * FROM free_games_subscriptions WHERE guild_id=?', [GUILD]);
  console.log(`free_games: ch=${fg?.discord_channel_id} role=${fg?.mention_role_id} enabled=${fg?.is_enabled}`);
  const [[tv]] = await db.query('SELECT * FROM temp_channel_config WHERE guild_id=?', [GUILD]);
  console.log(`temp_vc: creator=${tv?.creator_channel_id} cat=${tv?.category_id}`);
  const [[mu]] = await db.query('SELECT * FROM music_config WHERE guild_id=?', [GUILD]);
  console.log(`music: enabled=${mu?.enabled} req=${mu?.request_channel_id} vc=${mu?.default_voice_channel_id} dj=${mu?.dj_role_id}`);
  const [dis] = await db.query('SELECT command_name FROM guild_command_restrictions WHERE guild_id=? AND allowed=0', [GUILD]);
  console.log(`disabled cmds (${dis.length}): ${dis.map((d) => d.command_name).join(', ')}`);
  const [pan] = await db.query('SELECT panel_name FROM reaction_role_panels WHERE guild_id=?', [GUILD]);
  console.log(`reaction panels: ${pan.map((p) => p.panel_name).join(' | ')}`);
  const [[tp]] = await db.query('SELECT panel_id, panel_message_id FROM ticket_panels WHERE guild_id=?', [GUILD]);
  console.log(`ticket panel: ${tp?.panel_id} msg=${tp?.panel_message_id}`);
  const nsfw = guildChannels.filter((c) => c.nsfw).map((c) => c.name);
  console.log(`age-restricted channels: ${nsfw.join(', ') || 'NONE'}`);
  const am = await rest('GET', `/guilds/${GUILD}/auto-moderation/rules`).catch(() => []);
  console.log(`automod rules: ${(am || []).map((r) => r.name).join(', ')}`);
  console.log(`\ntotals: ${guildRoles.length} roles, ${guildChannels.length} channels`);
  console.log(problems.length ? `\n⚠️ ${problems.join('; ')}` : '\n✅ no problems detected');
}

// ── dispatch ─────────────────────────────────────────────────────────────────
const phase = process.argv[2] || 'show';
try {
  if (phase === 'preflight') await phasePreflight();
  else if (phase === 'roles') await phaseRoles();
  else if (phase === 'order') await phaseOrder();
  else if (phase === 'channels') await phaseChannels();
  else if (phase === 'config') await phaseConfig();
  else if (phase === 'panels') await phasePanels();
  else if (phase === 'streaming') await phaseStreaming();
  else if (phase === 'automod') await phaseAutomod();
  else if (phase === 'moderation') await phaseModeration();
  else if (phase === 'finalize') await phaseFinalize();
  else if (phase === 'verify') await phaseVerify();
  else if (phase === 'show') console.log(JSON.stringify(IDS, null, 2));
  else console.log(`unknown phase: ${phase}`);
} catch (e) {
  console.error('PHASE FAILED:', e.message);
  saveIds(); await db.end(); process.exit(1);
}
saveIds();
await db.end();
process.exit(0);
