/*
 * The Hive (1554057640504721409) — full server build from an empty guild.
 * Theme: a hive mind for gamer brains — cyberpunk bees. Modeled on Karabi's server
 * (814321716872347648) feature-for-feature, but restructured and re-themed, not copied.
 *
 *   node scripts/setup-the-hive.mjs <phase>
 *     phases: preflight | roles | channels | config | panels | streaming | automod | finalize | verify | show
 *     primary = the_gaming_bee (owner) — own live channel, schedule sync, go-live ping
 *
 * "CyberHive" font = Unicode Mathematical Monospace (A-Z U+1D670, a-z U+1D68A, 0-9 U+1D7F6 —
 * no unassigned holes). Applied to category + channel names only; role names stay plain so
 * they remain searchable/mentionable.
 *
 * Idempotent: every entity keyed by a stable slug in scripts/.hive-setup-ids.json.
 * All Discord ops are REST via the custom bot token (safe while PM2 runs — no gateway login).
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD = '1554057640504721409';
const KARABI = '814321716872347648';
const OWNER = '365905620060340224';
const TZ = 'Australia/Brisbane'; // same as Karabi's
const IDS_PATH = new URL('./.hive-setup-ids.json', import.meta.url);

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
    catch { clearTimeout(to); await sleep(600); continue; }
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

// ── "CyberHive" font ─────────────────────────────────────────────────────────
function mono(s) {
  return [...s].map((c) => {
    const o = c.codePointAt(0);
    if (o >= 65 && o <= 90) return String.fromCodePoint(0x1D670 + o - 65);
    if (o >= 97 && o <= 122) return String.fromCodePoint(0x1D68A + o - 97);
    if (o >= 48 && o <= 57) return String.fromCodePoint(0x1D7F6 + o - 48);
    return c;
  }).join('');
}
const catName = (s) => `⬡ ${mono(s.toUpperCase())} ⬡`;
const txtName = (emoji, s) => `${emoji}┃${mono(s)}`;
const vcName = (emoji, s) => `${emoji} ${mono(s)}`;

const C = {
  honey: 0xffb800, amber: 0xc9a227, cyan: 0x00f0ff, magenta: 0xff2a6d, toxic: 0x39ff14,
  violet: 0x9d4edd, laser: 0xff3131, solar: 0xff7b00, chrome: 0xd8dee9, grey: 0x707b8a,
  queen: 0xffd60a, guard: 0xff4d6d, warden: 0xff9e00, tech: 0x2ec4b6, live: 0x9146ff,
  lvl5: 0xe9c46a, lvl10: 0x80ffdb, lvl20: 0x48bfe3, lvl35: 0x7b2cbf, lvl50: 0xf72585,
  panel: 0xffb800,
};

// ── ROLES ────────────────────────────────────────────────────────────────────
// Created top → bottom. A new role lands at position 1 and pushes the rest up, so creation
// order IS the hierarchy (the bot can't PATCH positions above its own managed role, which
// starts at 1 on a fresh guild). Colour block sits above every other coloured non-staff role
// so the picker actually changes name colour; tag roles are colour 0.
const ROLE_DEFS = [
  // staff (coloured, above the picker by choice: staff always render in staff colour)
  { slug: 'queen', name: '👑 King Bee', color: C.queen, hoist: true },
  { slug: 'guard', name: '🛡️ Royal Guard', color: C.guard, hoist: true },
  { slug: 'warden', name: '⚔️ Hive Warden', color: C.warden, hoist: true },
  { slug: 'tech', name: '🔧 Hive Tech', color: C.tech, hoist: true },
  { slug: 'live', name: '🔴 Broadcasting', color: C.live, hoist: true },
  { slug: 'hatchday', name: '🎂 Hatch Day', color: C.honey, hoist: true },
  // colour picker
  { slug: 'col_honey', name: 'Honey Gold', color: C.honey, panel: 'colour', label: 'Honey Gold', emoji: '🟡' },
  { slug: 'col_cyan', name: 'Cyber Cyan', color: C.cyan, panel: 'colour', label: 'Cyber Cyan', emoji: '🩵' },
  { slug: 'col_magenta', name: 'Neon Magenta', color: C.magenta, panel: 'colour', label: 'Neon Magenta', emoji: '🩷' },
  { slug: 'col_toxic', name: 'Toxic Green', color: C.toxic, panel: 'colour', label: 'Toxic Green', emoji: '💚' },
  { slug: 'col_violet', name: 'Ultraviolet', color: C.violet, panel: 'colour', label: 'Ultraviolet', emoji: '💜' },
  { slug: 'col_laser', name: 'Laser Red', color: C.laser, panel: 'colour', label: 'Laser Red', emoji: '🔴' },
  { slug: 'col_solar', name: 'Solar Orange', color: C.solar, panel: 'colour', label: 'Solar Orange', emoji: '🧡' },
  { slug: 'col_chrome', name: 'Chrome', color: C.chrome, panel: 'colour', label: 'Chrome', emoji: '⚪' },
  // level ladder (coloured, below the picker — shows only for members who haven't picked)
  { slug: 'lvl50', name: '💠 Overmind', color: C.lvl50, hoist: true, level: 50 },
  { slug: 'lvl35', name: '🧠 Neural Core', color: C.lvl35, hoist: true, level: 35 },
  { slug: 'lvl20', name: '🧬 Augmented', color: C.lvl20, hoist: true, level: 20 },
  { slug: 'lvl10', name: '🔋 Charged Cell', color: C.lvl10, hoist: true, level: 10 },
  { slug: 'lvl5', name: '⚙️ Worker Unit', color: C.lvl5, hoist: true, level: 5 },
  // gate
  { slug: 'drone', name: '🐝 Drone', color: C.amber, hoist: true },
  { slug: 'streamer', name: '📡 Signal Caster', color: 0, hoist: true },
  // tag roles (colour 0)
  { slug: 'ping_announce', name: 'Hive Broadcasts', color: 0, panel: 'pings', label: 'Hive Broadcasts', emoji: '📢' },
  { slug: 'ping_events', name: 'Swarm Events', color: 0, panel: 'pings', label: 'Swarm Events', emoji: '📅' },
  { slug: 'ping_freegames', name: 'Free Games', color: 0, panel: 'pings', label: 'Free Games', emoji: '🎁' },
  { slug: 'ping_streams', name: 'Bee Live Alerts', color: 0, panel: 'pings', label: 'Bee Goes Live', emoji: '🐝' },
  { slug: 'ping_qotd', name: 'Question of the Day', color: 0, panel: 'pings', label: 'QOTD', emoji: '❓' },
  { slug: 'caste_soldier', name: 'Soldier Caste', color: 0, panel: 'caste', label: 'Soldier — competitive', emoji: '🗡️' },
  { slug: 'caste_forager', name: 'Forager Caste', color: 0, panel: 'caste', label: 'Forager — casual', emoji: '🍯' },
  { slug: 'caste_builder', name: 'Builder Caste', color: 0, panel: 'caste', label: 'Builder — creative', emoji: '🔨' },
  { slug: 'caste_strategist', name: 'Strategist Caste', color: 0, panel: 'caste', label: 'Strategist — tactical', emoji: '🧠' },
  { slug: 'caste_scout', name: 'Scout Caste', color: 0, panel: 'caste', label: 'Scout — explorer', emoji: '🔭' },
  { slug: 'g_fps', name: 'FPS', color: 0, panel: 'genres', label: 'FPS', emoji: '🔫' },
  { slug: 'g_br', name: 'Battle Royale', color: 0, panel: 'genres', label: 'Battle Royale', emoji: '🪂' },
  { slug: 'g_mmo', name: 'MMO / RPG', color: 0, panel: 'genres', label: 'MMO / RPG', emoji: '⚔️' },
  { slug: 'g_survival', name: 'Survival & Crafting', color: 0, panel: 'genres', label: 'Survival & Crafting', emoji: '🏗️' },
  { slug: 'g_strategy', name: 'Strategy', color: 0, panel: 'genres', label: 'Strategy', emoji: '♟️' },
  { slug: 'g_fighting', name: 'Fighting', color: 0, panel: 'genres', label: 'Fighting', emoji: '🥊' },
  { slug: 'g_racing', name: 'Racing', color: 0, panel: 'genres', label: 'Racing', emoji: '🏎️' },
  { slug: 'g_horror', name: 'Horror', color: 0, panel: 'genres', label: 'Horror', emoji: '👻' },
  { slug: 'g_cozy', name: 'Cozy / Indie', color: 0, panel: 'genres', label: 'Cozy / Indie', emoji: '🌱' },
  { slug: 'g_retro', name: 'Retro', color: 0, panel: 'genres', label: 'Retro', emoji: '🕹️' },
  { slug: 'p_pc', name: 'PC', color: 0, panel: 'platform', label: 'PC', emoji: '🖥️' },
  { slug: 'p_xbox', name: 'Xbox', color: 0, panel: 'platform', label: 'Xbox', emoji: '🟩' },
  { slug: 'p_ps', name: 'PlayStation', color: 0, panel: 'platform', label: 'PlayStation', emoji: '🟦' },
  { slug: 'p_switch', name: 'Switch', color: 0, panel: 'platform', label: 'Switch', emoji: '🟥' },
  { slug: 'p_mobile', name: 'Mobile', color: 0, panel: 'platform', label: 'Mobile', emoji: '📱' },
  { slug: 'p_vr', name: 'VR', color: 0, panel: 'platform', label: 'VR', emoji: '🥽' },
  { slug: 'r_na', name: 'North America', color: 0, panel: 'region', label: 'North America', emoji: '🌎' },
  { slug: 'r_sa', name: 'South America', color: 0, panel: 'region', label: 'South America', emoji: '🌎' },
  { slug: 'r_eu', name: 'Europe', color: 0, panel: 'region', label: 'Europe', emoji: '🌍' },
  { slug: 'r_afme', name: 'Africa & Middle East', color: 0, panel: 'region', label: 'Africa & Middle East', emoji: '🌍' },
  { slug: 'r_asia', name: 'Asia', color: 0, panel: 'region', label: 'Asia', emoji: '🌏' },
  { slug: 'r_oce', name: 'Oceania', color: 0, panel: 'region', label: 'Oceania', emoji: '🌏' },
  { slug: 'pr_he', name: 'He/Him', color: 0, panel: 'pronouns', label: 'He/Him', emoji: '💙' },
  { slug: 'pr_she', name: 'She/Her', color: 0, panel: 'pronouns', label: 'She/Her', emoji: '💗' },
  { slug: 'pr_they', name: 'They/Them', color: 0, panel: 'pronouns', label: 'They/Them', emoji: '💜' },
  { slug: 'pr_any', name: 'Any Pronouns', color: 0, panel: 'pronouns', label: 'Any Pronouns', emoji: '🤍' },
  { slug: 'pr_ask', name: 'Ask My Pronouns', color: 0, panel: 'pronouns', label: 'Ask Me', emoji: '💛' },
  // bottom
  { slug: 'larva', name: '🥚 Larva', color: C.grey },
];

// Divider roles: colourless, permissionless, never hoisted or assigned — they only group the
// role list. Name is the CyberHive font between hex rails.
const divider = (slug, label) => ({ slug: `div_${slug}`, name: `⬡━━━ ${mono(label.toUpperCase())} ━━━⬡`, color: 0, divider: true });
const DIVIDERS = {
  status: divider('status', 'Status'), colours: divider('colours', 'Colours'), command: divider('command', 'Hive Command'),
  ranks: divider('ranks', 'Hive Ranks'), signals: divider('signals', 'Signals'), interests: divider('interests', 'Interests'),
  about: divider('about', 'About Me'),
};
ROLE_DEFS.push(...Object.values(DIVIDERS));

// Top → bottom display order (below the bot). Status roles (Hatch Day, Broadcasting) sit ABOVE the
// colour picker on purpose — the owner moved them there so a birthday/live colour overrides a pick.
// Hoisted = member-list sections: status → staff → Signal Caster → level ladder → Drone.
const slugsOf = (panel) => ROLE_DEFS.filter((d) => d.panel === panel).map((d) => d.slug);
const ROLE_ORDER = [
  'div_status', 'hatchday', 'live',
  'div_colours', ...slugsOf('colour'),
  'div_command', 'queen', 'guard', 'warden', 'tech',
  'div_ranks', 'streamer', 'lvl50', 'lvl35', 'lvl20', 'lvl10', 'lvl5', 'drone',
  'div_signals', ...slugsOf('pings'),
  'div_interests', ...slugsOf('caste'), ...slugsOf('genres'), ...slugsOf('platform'),
  'div_about', ...slugsOf('region'), ...slugsOf('pronouns'),
  'larva',
];
{
  const missing = ROLE_DEFS.map((d) => d.slug).filter((sl) => !ROLE_ORDER.includes(sl));
  if (missing.length) throw new Error(`ROLE_ORDER is missing: ${missing.join(', ')}`);
}

const PANELS = [
  { slug: 'pings', name: '🔔 Signal Subscriptions', mode: 'multiple', color: C.honey,
    desc: 'Choose which transmissions the hive is allowed to ping you for. Click again to unsubscribe.' },
  { slug: 'colour', name: '🎨 Chromatic Implant', mode: 'unique', color: C.magenta,
    desc: 'Pick **one** name colour. Picking another swaps it; click your current one to remove it.' },
  { slug: 'caste', name: '🐝 Hive Caste', mode: 'multiple', color: C.amber,
    desc: 'Every hive runs on castes. How do you play?' },
  { slug: 'genres', name: '🎮 Game Genres', mode: 'multiple', color: C.cyan,
    desc: 'What does your gamer brain run on? Pick as many as you like — handy for finding a squad in LFG.' },
  { slug: 'platform', name: '🕹️ Platforms', mode: 'multiple', color: C.toxic,
    desc: 'Where do you play?' },
  { slug: 'region', name: '🌐 Region', mode: 'multiple', color: C.violet,
    desc: 'Where in the world is your node? Helps with squad-ups across time zones.' },
  { slug: 'pronouns', name: '💬 Pronouns', mode: 'multiple', color: C.chrome,
    desc: 'Let the hive know how to refer to you.' },
];

async function phasePreflight() {
  await refresh();
  const botRole = guildRoles.find((r) => r.managed && r.tags?.bot_id === BOT_ID);
  const perms = BigInt(botRole?.permissions || '0');
  console.log(`bot ${BOT_ID} role "${botRole?.name}" ${botRole?.id} pos=${botRole?.position} admin=${(perms & 8n) === 8n}`);
  const g = await rest('GET', `/guilds/${GUILD}`);
  console.log(`guild "${g.name}" owner=${g.owner_id} features=${g.features.join(',') || '-'} verif=${g.verification_level}`);
  console.log(`roles=${guildRoles.length} channels=${guildChannels.length}`);
  IDS.misc.botRole = botRole?.id; saveIds();
}

async function ensureRole(def) {
  const { slug, name, color = 0, hoist = false } = def;
  const id = IDS.roles[slug];
  const ex = id ? guildRoles.find((r) => r.id === id) : guildRoles.find((r) => r.name === name);
  if (ex) {
    if (ex.name !== name || ex.color !== color || ex.hoist !== hoist) {
      await rest('PATCH', `/guilds/${GUILD}/roles/${ex.id}`, { name, color, hoist }, 'The Hive setup: normalize role');
      await sleep(300);
    }
    IDS.roles[slug] = ex.id; return ex.id;
  }
  const created = await rest('POST', `/guilds/${GUILD}/roles`,
    { name, color, hoist, mentionable: false, permissions: '0' }, `The Hive setup: create ${name}`);
  IDS.roles[slug] = created.id; guildRoles.push(created); await sleep(350);
  return created.id;
}

// staff permission sets (role-level; channel overwrites handle visibility)
const P = {
  ADMIN: 1n << 3n, KICK: 1n << 1n, BAN: 1n << 2n, MANAGE_CH: 1n << 4n, MANAGE_GUILD: 1n << 5n,
  AUDIT: 1n << 7n, MANAGE_MSG: 1n << 13n, MANAGE_NICK: 1n << 27n, MANAGE_ROLES: 1n << 28n,
  MANAGE_THREADS: 1n << 34n, MODERATE: 1n << 40n, MUTE: 1n << 22n, DEAF: 1n << 23n, MOVE: 1n << 24n,
  MENTION_EVERYONE: 1n << 17n, VIEW: 1n << 10n,
};
const STAFF_PERMS = {
  queen: P.ADMIN,
  guard: P.ADMIN,
  warden: P.KICK | P.BAN | P.AUDIT | P.MANAGE_MSG | P.MANAGE_NICK | P.MANAGE_THREADS | P.MODERATE | P.MUTE | P.DEAF | P.MOVE | P.MENTION_EVERYONE,
  tech: P.MANAGE_MSG | P.MANAGE_THREADS | P.MODERATE | P.MOVE,
};

async function phaseRoles() {
  await refresh();
  for (const d of ROLE_DEFS) { console.log(`  ${d.name.padEnd(24)} ${await ensureRole(d)}`); saveIds(); }
  for (const [slug, perms] of Object.entries(STAFF_PERMS)) {
    await rest('PATCH', `/guilds/${GUILD}/roles/${R(slug)}`, { permissions: String(perms) }, 'The Hive setup: staff perms');
    await sleep(300);
  }
  console.log('· staff permissions applied');
  // (the initial build gave the owner 👑 King Bee; not repeated — role holders are managed by hand now)
  console.log(`\n${Object.keys(IDS.roles).length} roles tracked.`);
  await refresh();
  const order = [...guildRoles].sort((a, b) => b.position - a.position).map((r) => `${r.position}:${r.name}`);
  console.log(order.join(' | '));
}

// ── CHANNELS ─────────────────────────────────────────────────────────────────
const B = {
  VIEW: 1n << 10n, SEND: 1n << 11n, HISTORY: 1n << 16n, ADDREACT: 1n << 6n,
  EMBED: 1n << 14n, ATTACH: 1n << 15n, EXTEMOJI: 1n << 18n, APPCMDS: 1n << 31n,
  CONNECT: 1n << 20n, SPEAK: 1n << 21n, USEVAD: 1n << 25n, STREAM: 1n << 9n,
  MANAGE_MSG: 1n << 13n, CREATE_THREAD: 1n << 35n, SEND_THREAD: 1n << 38n, MENTION_EVERYONE: 1n << 17n,
};
const TEXT_MEMBER = B.VIEW | B.SEND | B.HISTORY | B.ADDREACT | B.EMBED | B.ATTACH | B.EXTEMOJI | B.APPCMDS | B.CREATE_THREAD | B.SEND_THREAD;
const VOICE_MEMBER = B.VIEW | B.CONNECT | B.SPEAK | B.USEVAD | B.STREAM | B.SEND | B.HISTORY;
const RO_ALLOW = B.VIEW | B.HISTORY | B.ADDREACT;
const RO_DENY = B.SEND | B.CREATE_THREAD | B.SEND_THREAD;
const ow = (id, allow, deny) => ({ id, type: 0, allow: String(allow), deny: String(deny) });
const EVERYONE = GUILD;
const staffOw = () => ['warden', 'tech'].map((s) => ow(R(s), TEXT_MEMBER | VOICE_MEMBER | B.MANAGE_MSG, 0n));
const botOw = () => (IDS.misc.botRole ? [ow(IDS.misc.botRole, TEXT_MEMBER | VOICE_MEMBER | B.MANAGE_MSG, 0n)] : []);

function perms(kind) {
  const d = R('drone');
  const base = [...staffOw(), ...botOw()];
  switch (kind) {
    case 'public': return [ow(EVERYONE, RO_ALLOW, RO_DENY), ...base];
    case 'ro': return [ow(EVERYONE, 0n, B.VIEW), ow(d, RO_ALLOW, RO_DENY), ...base];
    case 'chat': return [ow(EVERYONE, 0n, B.VIEW), ow(d, TEXT_MEMBER, 0n), ...base];
    case 'voice': return [ow(EVERYONE, 0n, B.VIEW), ow(d, VOICE_MEMBER, 0n), ...base];
    case 'stats': return [ow(EVERYONE, B.VIEW, B.CONNECT), ...botOw()];
    case 'staff': return [ow(EVERYONE, 0n, B.VIEW), ...base];
    default: throw new Error(kind);
  }
}

// [slug, name, type, perms, topic]
const LAYOUT = [
  { slug: 'gate', name: 'Hive Gate', perms: 'public', channels: [
    ['welcome', txtName('👋', 'welcome'), 0, 'public', 'New drones enter here. Read #rules, then plug in.'],
    // join/leave traffic lives here so the #welcome guide never gets buried
    ['arrivals', txtName('🛬', 'arrivals'), 0, 'public', 'Drones connecting to and disconnecting from the hive.'],
    ['rules', txtName('📜', 'rules'), 0, 'public', 'The hive protocol. Accept it to sync with the hive mind.'],
    ['announcements', txtName('📢', 'announcements'), 0, 'public', 'Official transmissions from hive command.'],
    ['getroles', txtName('🎭', 'get-roles'), 0, 'ro', 'Configure your implants: pings, colour, caste, games, platform, region, pronouns.'],
  ] },
  { slug: 'clock', name: 'Hive Clock', perms: 'stats', channels: [
    ['stattime', '🕐 | loading…', 2, 'stats'],
    ['statdate', '📅 | loading…', 2, 'stats'],
    ['statmembers', '🐝 | loading…', 2, 'stats'],
  ] },
  { slug: 'comb', name: 'The Honeycomb', perms: 'chat', channels: [
    ['general', txtName('🧠', 'hive-mind'), 0, 'chat', 'General chat — one hive, many brains.'],
    ['intros', txtName('🧬', 'introductions'), 0, 'chat', 'Upload your profile: who you are, what you play, what you are grinding right now.'],
    ['media', txtName('📸', 'media'), 0, 'chat', 'Pics, art, screenshots — anything visual.'],
    ['memes', txtName('😂', 'memes'), 0, 'chat', 'Memes and shitposts. Keep it within the rules.'],
    ['battlestations', txtName('🖥️', 'battlestations'), 0, 'chat', 'Show off your setup — rigs, desks, peripherals, cable-management crimes.'],
    ['pets', txtName('🐾', 'pets'), 0, 'chat', 'The real hive bosses — show off your pets. Cats, dogs, lizards, bees, all welcome.'],
    ['qotd', txtName('❓', 'question-of-the-day'), 0, 'chat', 'A new question every day. Answer in the thread or right here.'],
    ['suggestions', txtName('💡', 'suggestions'), 0, 'chat', 'Ideas to upgrade the hive. Use /suggest.'],
    ['confessions', txtName('🤫', 'confessions'), 0, 'ro', 'Anonymous confessions — post with /confess. Staff can still trace abuse.'],
    ['starboard', txtName('⭐', 'hall-of-honey'), 0, 'ro', 'Hall of fame — any message that collects 3 ⭐ gets preserved here.'],
    ['birthdays', txtName('🎂', 'hatch-days'), 0, 'ro', 'Birthday broadcasts. Set yours with /birthday.'],
    ['levelup', txtName('⚡', 'level-up'), 0, 'ro', 'Level-up notifications. Worker Unit at 5, Overmind at 50.'],
  ] },
  { slug: 'gamer', name: 'Gamer Brains', perms: 'chat', channels: [
    ['gaming', txtName('🎮', 'gaming-chat'), 0, 'chat', 'Talk games — whatever you are playing, hyped for, or raging at.'],
    ['lfg', txtName('🎯', 'looking-for-group'), 0, 'chat', 'Need a squad? Post the game, platform, region and how many slots.'],
    ['clips', txtName('🎬', 'clips-and-highlights'), 0, 'chat', 'Clutches, fails and highlights.'],
    ['boardgames', txtName('🎲', 'board-games'), 0, 'chat', 'Tabletop, card and board games — IRL or online. Game nights, recs and rule arguments.'],
    ['freegames', txtName('🎁', 'free-games'), 0, 'ro', 'Free game drops from Steam, Epic, GOG and more — grab the Free Games ping role.'],
  ] },
  { slug: 'broadcast', name: 'Broadcast', perms: 'ro', channels: [
    ['beelive', txtName('🐝', 'bee-live'), 0, 'ro', 'The Gaming Bee goes live here — twitch.tv/the_gaming_bee. Grab Bee Live Alerts in #get-roles to get pinged.'],
    ['schedule', txtName('🗓️', 'stream-schedule'), 0, 'ro', "The Gaming Bee's stream schedule, synced from Twitch."],
    ['live', txtName('🔴', 'live-now'), 0, 'ro', 'Hive members who are live right now.'],
    ['selfpromo', txtName('📡', 'self-promo'), 0, 'chat', 'Drop your stream / channel link here and the bot will track you.'],
    ['streamsignup', txtName('📝', 'stream-signup'), 0, 'ro', 'Get your streams announced in #live-now automatically.'],
  ] },
  { slug: 'arcade', name: 'Hive Arcade', perms: 'chat', channels: [
    ['counting', txtName('🔢', 'counting'), 0, 'chat', 'How high can the hive count? Wrong numbers get deleted.'],
    ['tree', txtName('🌳', 'grow-a-tree'), 0, 'chat', 'Water the hive tree with /tree.'],
    ['wordle', txtName('🔤', 'wordle'), 0, 'chat', 'Co-op wordle — the whole hive guesses together.'],
    ['botcmds', txtName('🤖', 'bot-commands'), 0, 'chat', 'Spam bot commands here — /rank, /leaderboard, etc.'],
  ] },
  { slug: 'voice', name: 'Voice Combs', perms: 'voice', channels: [
    ['vccreate', vcName('➕', 'Spawn a Comb'), 2, 'voice'],
    ['vclounge', vcName('🐝', 'The Hive Lounge'), 2, 'voice'],
    ['vcalpha', vcName('🎮', 'Squad Alpha'), 2, 'voice'],
    ['vcbeta', vcName('🎮', 'Squad Beta'), 2, 'voice'],
    ['vcmusic', vcName('🎵', 'Frequency'), 2, 'voice'],
    ['vcafk', vcName('💤', 'Stasis Pod'), 2, 'voice'],
  ] },
  { slug: 'support', name: 'Support', perms: 'ro', channels: [
    ['support', txtName('🎫', 'support'), 0, 'ro', 'Open a private ticket with hive staff.'],
  ] },
  { slug: 'tickets', name: 'Tickets', perms: 'staff', channels: [] },
  { slug: 'staff', name: "King's Chamber", perms: 'staff', channels: [
    ['staffchat', txtName('🛡️', 'staff-chat'), 0, 'staff', 'Staff only.'],
    ['modlog', txtName('📋', 'mod-log'), 0, 'staff', 'Server event log.'],
    ['modalerts', txtName('🚨', 'mod-alerts'), 0, 'staff', 'AutoMod, raid, phishing and global-ban alerts.'],
    ['updates', txtName('🛠️', 'discord-updates'), 0, 'staff', 'Discord community updates.'],
  ] },
];

async function ensureCategory(slug, name, owr, position) {
  let id = IDS.categories[slug];
  const cur = id ? guildChannels.find((c) => c.id === id) : guildChannels.find((c) => c.type === 4 && c.name === name);
  if (cur) {
    id = cur.id;
    await rest('PATCH', `/channels/${id}`, { name, position, permission_overwrites: owr }, 'The Hive setup: category');
  } else {
    const created = await rest('POST', `/guilds/${GUILD}/channels`, { name, type: 4, position, permission_overwrites: owr }, 'The Hive setup: create category');
    id = created.id; guildChannels.push(created);
  }
  IDS.categories[slug] = id; saveIds(); await sleep(400);
  return id;
}

async function ensureChannel([slug, name, type, kind, topic], parent_id, position) {
  let id = IDS.channels[slug];
  const cur = id ? guildChannels.find((c) => c.id === id) : guildChannels.find((c) => c.name === name && c.parent_id === parent_id);
  const body = { parent_id, position, permission_overwrites: perms(kind) };
  if (type === 0 && topic) body.topic = topic;
  if (cur) {
    id = cur.id;
    await rest('PATCH', `/channels/${id}`, body, 'The Hive setup: place channel');
  } else {
    const created = await rest('POST', `/guilds/${GUILD}/channels`, { name, type, ...body }, 'The Hive setup: create channel');
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
    await rest('PATCH', `/guilds/${GUILD}/roles/${EVERYONE}`, { permissions: String(cur & ~B.MENTION_EVERYONE) }, 'The Hive: harden everyone');
    console.log('· removed MENTION_EVERYONE from @everyone'); await sleep(320);
  }
  let pos = 0;
  for (const cat of LAYOUT) {
    const name = catName(cat.name);
    const cid = await ensureCategory(cat.slug, name, perms(cat.perms), pos++);
    console.log(`▼ ${name}  ${cid}`);
    let cp = 0;
    for (const def of cat.channels) console.log(`    ${def[1].padEnd(28)} ${await ensureChannel(def, cid, cp++)}`);
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
async function autoIncCols(table) {
  const [cols] = await db.query(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND EXTRA LIKE "%auto_increment%"', [table]);
  return cols.map((c) => c.COLUMN_NAME);
}
// clone Karabi's row (guarantees the column shapes her live config uses), then remap ids
async function cloneOne(table, overrides = {}, { where = 'guild_id=? LIMIT 1', drop = ['created_at', 'updated_at'] } = {}) {
  const [rows] = await db.query(`SELECT * FROM \`${table}\` WHERE ${where}`, [KARABI]);
  if (!rows.length) { console.log(`  ${table}: no source row — skip`); return false; }
  const row = { ...rows[0] };
  for (const ai of await autoIncCols(table)) delete row[ai];
  for (const d of drop) delete row[d];
  row.guild_id = GUILD;
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in row)) throw new Error(`${table}: override '${k}' is not a column`);
    row[k] = v;
  }
  await db.query(`DELETE FROM \`${table}\` WHERE guild_id=?`, [GUILD]);
  const keys = Object.keys(row);
  await db.query(`INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k]));
  console.log(`  ${table}: cloned + remapped`);
  return true;
}

const LOG_EVENTS = ['ban', 'unban', 'memberKick', 'memberJoin', 'memberLeave', 'memberUpdate',
  'messageDelete', 'messageUpdate', 'channelCreate', 'channelDelete', 'channelUpdate',
  'roleCreate', 'roleDelete', 'roleUpdate', 'guildUpdate', 'inviteCreate', 'inviteDelete',
  'threadCreate', 'threadDelete', 'webhookUpdate', 'moderation', 'tickets'];
// deliberately excluded: emoji*/sticker*/soundboard* (hard-blocked in log-manager anyway),
// voiceUpdate + threadUpdate + integrationUpdate (spam)


async function phaseConfig() {
  const modalerts = CH('modalerts'), modlog = CH('modlog');
  console.log('— onboarding —');
  await up('verify_config', { verified_role_id: R('drone'), unverified_role_id: R('larva'), gate_channel_id: CH('rules'), enabled: 1 });
  await up('welcome_settings', {
    channel_id: CH('arrivals'), auto_role_id: R('larva'),
    message: `🐝 **Signal acquired.** Welcome to **The Hive**, {user}!\nSync with the protocol in <#${CH('rules')}>, then configure your implants in <#${CH('getroles')}>.`,
    goodbye_enabled: 1, goodbye_channel_id: CH('arrivals'), goodbye_message: '📴 {user} has disconnected from the hive.',
    card_title_text: 'Welcome, {user}!', card_subtitle_text: 'New drone synced to {server}', card_style: 'dark',
  });
  await up('autoroles_config', { is_enabled: 1, roles_to_assign: JSON.stringify([R('larva')]) });

  console.log('— protection (Karabi\'s settings, remapped) —');
  await cloneOne('anti_nuke_config', { alert_channel_id: modalerts });
  await cloneOne('raid_detection_config', { alert_channel_id: modalerts });
  await cloneOne('phishing_config', { alert_channel_id: modalerts, report_channel_id: modalerts });
  await cloneOne('commission_spam_config', { log_channel_id: modalerts, deleted_count: 0, last_hit_at: null, soft_sell_deleted_count: 0, soft_sell_review_count: 0 });
  await up('global_ban_config', {
    enabled: 1, action_critical: 'ban', action_high: 'ban', action_medium: 'kick', action_low: 'alert',
    alert_channel_id: modalerts, log_actions: 1, check_on_join: 1, check_on_message: 0,
    auto_aggregate_opt_in: 1, exempt_roles: JSON.stringify([R('queen'), R('guard'), R('warden')]),
  });
  await up('moderation_config', { mod_log_channel_id: modlog });

  console.log('— logging —');
  await up('logging_config', { log_channel_id: modlog, enabled: 1, enabled_events: JSON.stringify(LOG_EVENTS) });
  await db.query('DELETE FROM log_event_config WHERE guild_id=?', [GUILD]);
  for (const ev of LOG_EVENTS) {
    await db.query('INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id) VALUES (?,?,1,?)', [GUILD, ev, modlog]);
  }
  console.log(`  log_event_config: ${LOG_EVENTS.length} events`);

  console.log('— engagement —');
  await cloneOne('level_config', { level_up_channel_id: CH('levelup'), level_up_message: '⚡ {user} upgraded to **Level {level}**. The hive grows stronger.' });
  await db.query('DELETE FROM level_role_rewards WHERE guild_id=?', [GUILD]);
  const ladder = ROLE_DEFS.filter((d) => d.level);
  for (const d of ladder) await db.query('INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?,?,?)', [GUILD, d.level, R(d.slug)]);
  console.log(`  level_role_rewards: ${ladder.map((d) => `L${d.level}`).join(' ')}`);
  await up('birthday_config', {
    announcement_channel_id: CH('birthdays'), enabled: 1, birthday_role_id: R('hatchday'),
    message_template: '🎂 Hatch Day detected! Happy birthday, {mention} — the whole hive is buzzing for you today. 🐝',
    card_channel_id: CH('birthdays'), cards_enabled: 1, default_card_type: 'board',
  });
  await cloneOne('confession_config', { channel_id: CH('confessions') });
  await cloneOne('suggestion_config', { suggestions_channel_id: CH('suggestions'), min_votes_for_approval: 5 });
  await cloneOne('starboard_config', { channel_id: CH('starboard') }, { drop: [] });
  await cloneOne('qotd_channels', {
    channel_id: CH('qotd'), timezone: TZ, active_deck_id: null, last_posted_at: null,
    source_mode: 'library', embed_title: '❓ Question of the Hive', embed_color: '#FFB800', thread_enabled: 1,
  }, { drop: ['created_at', 'updated_at'] });

  console.log('— timezone (all three stores) —');
  await up('guild_settings', { timezone: TZ });
  await up('tz_guild_config', { enabled: 1, time_zone: TZ, time_format: '12', auto_detect: 'off' });
  await db.query('UPDATE guild_config SET timezone=? WHERE guild_id=?', [TZ, GUILD]).catch(() => {});

  console.log('— arcade —');
  await cloneOne('counting_channels', { channel_id: CH('counting'), current_count: 0, highest_count: 0, last_user_id: null, reset_count: 0 },
    { where: 'guild_id=? AND is_active=1 LIMIT 1' });
  await db.query('DELETE FROM gat_trees WHERE guild_id=?', [GUILD]);
  await db.query(
    'INSERT INTO gat_trees (guild_id, name, size, pieces, background, last_watered_by, last_watered_at, planted_by, compost) VALUES (?,?,0,?,?,?,?,?,0)',
    [GUILD, 'The Hive Tree', '[]', 'Sky', OWNER, Math.floor(Date.now() / 1000), OWNER]);
  console.log('  gat_trees: planted "The Hive Tree"');
  await db.query(
    `INSERT INTO word_game_channels (guild_id, channel_id, game_type, enabled, created_by) VALUES (?,?,?,1,?)
     ON DUPLICATE KEY UPDATE game_type=VALUES(game_type), enabled=1`, [GUILD, CH('wordle'), 'coordle', OWNER]);
  console.log('  word_game_channels: coordle');

  console.log('— command pins —');
  await db.query('DELETE FROM guild_command_restrictions WHERE guild_id=?', [GUILD]);
  const pins = [['tree', CH('tree')]];
  for (const [cmd, ch] of pins) {
    await db.query('INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only, channel_id) VALUES (?,?,1,0,?)', [GUILD, cmd, ch]);
  }
  // owner dropped the cat game 2026-09-28 — /cat answers "not available in this server"
  await db.query('INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only) VALUES (?,?,0,0)', [GUILD, 'cat']);
  console.log(`  ${pins.length} commands pinned, /cat disabled`);

  console.log('— voice —');
  await up('temp_channel_config', { creator_channel_id: CH('vccreate'), category_id: CAT('voice'), naming_template: "⬡ {user}'s Comb", default_user_limit: 0 });
  await up('music_config', { is_enabled: 1, enabled: 1, default_volume: 50, vote_skip_enabled: 1, vote_skip_percentage: 50 });

  console.log('— stat channels —');
  await db.query('DELETE FROM stat_display_channels WHERE guild_id=?', [GUILD]);
  for (const [slug, type, tpl] of [['stattime', 'time', '🕐 | {value}'], ['statdate', 'date', '📅 | {value}'], ['statmembers', 'humans', '🐝 | {value} drones']]) { // members counter = humans only, bots not counted
    await db.query('INSERT INTO stat_display_channels (guild_id, channel_id, stat_type, template) VALUES (?,?,?,?)', [GUILD, CH(slug), type, tpl]);
  }
  console.log('  stat_display_channels: 3');

  console.log('— free games —');
  await cloneOne('free_games_subscriptions', { discord_channel_id: CH('freegames'), mention_role_id: R('ping_freegames') });
  // game news dropped by the owner 2026-09-28 — no watchers
  await db.query('DELETE FROM game_patch_watchers WHERE guild_id=?', [GUILD]);

  await up('auto_publisher_config', { is_enabled: 1 });
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

async function phasePanels() {
  await refresh();
  if (!IDS.panels.guide) {
    const embed = {
      title: '⬡ THE HIVE ⬡',
      color: C.honey,
      description: [
        '**A hive mind for gamer brains.** One network, many players — plug in and sync up.',
        '',
        '**How to connect**',
        `**1.** Read the protocol in <#${CH('rules')}> and hit **Sync Me**.`,
        `**2.** Configure your implants in <#${CH('getroles')}> — pings, colour, caste, games.`,
        `**3.** Say hi in <#${CH('intros')}> and jump into <#${CH('general')}>.`,
        '',
        '**Sectors**',
        `🧠 **The Honeycomb** — chat, media, memes, battlestations, pets, QOTD`,
        `🎮 **Gamer Brains** — gaming chat, <#${CH('lfg')}>, clips, board games, free games`,
        `📡 **Broadcast** — hive members live now + stream signup`,
        `🕹️ **Hive Arcade** — counting, grow-a-tree, co-op wordle`,
        `🔊 **Voice Combs** — join **➕ Spawn a Comb** to get your own voice channel`,
        '',
        '**Ranks** — chat and hang out in voice to level up:',
        '⚙️ Worker Unit (5) → 🔋 Charged Cell (10) → 🧬 Augmented (20) → 🧠 Neural Core (35) → 💠 Overmind (50)',
      ].join('\n'),
      footer: { text: 'The Hive • we are many' },
    };
    const msg = await post(CH('welcome'), { embeds: [embed] });
    IDS.panels.guide = msg.id; saveIds();
    console.log(`  guide posted ${msg.id}`);
  } else console.log('  guide: exists');

  if (!IDS.panels.verify) {
    const embed = {
      title: '📜 Hive Protocol',
      color: C.honey,
      description: [
        '**⚠️ The Hive is an 18+ community.** Mature language and adult humour are part of the vibe here — including on The Gaming Bee\'s streams.',
        '',
        'Every drone in the hive runs the same protocol. Break it and you get disconnected.',
        '',
        '**01 ⬡ Respect the swarm.** No harassment, hate speech, racism, sexism, homophobia or transphobia. Zero tolerance.',
        '**02 ⬡ No toxicity.** Trash talk is fine — actually being a jerk isn\'t. Keep rage in the game.',
        '**03 ⬡ 18+ only — mature, not explicit.** Swearing and adult jokes are fine. No porn or sexual content, gore or shock content — anywhere.',
        `**04 ⬡ No spam or ads.** No DM advertising. Self-promo lives in <#${CH('selfpromo')}> only.`,
        '**05 ⬡ No cheats, hacks or piracy.** Don\'t share, sell or ask for them.',
        '**06 ⬡ Use the right channel.** Keep conversations in the sector they belong to.',
        '**07 ⬡ Protect your data.** Don\'t share personal info — yours or anyone else\'s.',
        '**08 ⬡ Follow Discord\'s rules.** [Terms](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines) apply.',
        '**09 ⬡ Hive staff have final say.** Questions? Open a ticket.',
        '',
        'Hit **Sync Me** to confirm you are **18 or older** and accept the protocol.',
      ].join('\n'),
      footer: { text: 'The Hive • 18+ • accepting grants the 🐝 Drone role' },
    };
    const row = { type: 1, components: [{ type: 2, style: 3, label: "Sync Me — I'm 18+", custom_id: 'verify_accept', emoji: { name: '🐝' } }] };
    const msg = await post(CH('rules'), { embeds: [embed], components: [row] });
    await db.query('UPDATE verify_config SET gate_message_id=? WHERE guild_id=?', [msg.id, GUILD]);
    IDS.panels.verify = msg.id; saveIds();
    console.log(`  verify gate posted ${msg.id}`);
  } else console.log('  verify gate: exists');

  for (const p of PANELS) {
    if (IDS.panels[p.slug]) { console.log(`  panel ${p.slug}: exists`); continue; }
    const defs = ROLE_DEFS.filter((d) => d.panel === p.slug);
    const items = defs.map((d) => [`rr_${R(d.slug)}`, d.label, d.emoji]);
    const embed = { title: p.name, color: p.color, description: p.desc };
    const msg = await post(CH('getroles'), { embeds: [embed], components: buttonRows(items) });
    const [ins] = await db.query(
      `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
       VALUES (?,?,?,?,?,?,'button',?)`,
      [GUILD, CH('getroles'), msg.id, p.name, p.desc, hex(p.color), p.mode]);
    for (const d of defs) {
      await db.query('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?,?,?,?,2)', [ins.insertId, R(d.slug), d.emoji, d.label]);
    }
    IDS.panels[p.slug] = msg.id; saveIds();
    console.log(`  panel ${p.slug}: ${msg.id} (${defs.length} roles)`);
  }

  const TICKETS = [
    { slug: 'ticket_support', name: 'Hive Support', title: '🎫 Hive Support', color: C.tech, emoji: '🎫', button: 'Open a Ticket', style: 1,
      desc: 'Questions, role problems, bugs, partnership enquiries — open a private ticket and hive staff will get back to you.' },
    { slug: 'ticket_report', name: 'Report a Member', title: '🚨 Report a Member', color: C.laser, emoji: '🚨', button: 'File a Report', style: 4,
      desc: 'Someone breaking protocol? File a private report. Include usernames, message links and screenshots if you can.' },
  ];
  for (const t of TICKETS) {
    if (IDS.panels[t.slug]) { console.log(`  ${t.slug}: exists`); continue; }
    const [ins] = await db.query(
      `INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color, button_text, button_emoji, ticket_category_id, support_role_id, ticket_name_format, save_transcripts, log_channel_id, alert_channel_id, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,1)`,
      [GUILD, t.name, CH('support'), t.title, t.desc, hex(t.color), t.button, t.emoji, CAT('tickets'), R('warden'), 'ticket-{username}', CH('modlog'), CH('modalerts')]);
    const row = { type: 1, components: [{ type: 2, style: t.style, label: t.button, custom_id: `ticket_create_panel_${ins.insertId}`, emoji: { name: t.emoji } }] };
    const msg = await post(CH('support'), { embeds: [{ title: t.title, color: t.color, description: t.desc }], components: [row] });
    await db.query('UPDATE ticket_panels SET panel_message_id=? WHERE panel_id=?', [msg.id, ins.insertId]);
    IDS.panels[t.slug] = msg.id; saveIds();
    console.log(`  ${t.slug}: ${msg.id} (panel ${ins.insertId})`);
  }
  console.log('\nPanels phase done.');
}

// ── STREAMING ────────────────────────────────────────────────────────────────
const PLATFORMS = ['twitch', 'kick', 'youtube', 'tiktok', 'rumble', 'facebook'];
async function phaseStreaming() {
  await up('self_promo_config', {
    enabled: 1, channel_id: CH('selfpromo'), auto_subscribe: 1,
    announcement_channel_id: CH('live'), same_channel: 0,
    allowed_platforms: JSON.stringify(PLATFORMS),
    delete_invalid: 0, keep_message: 1, dm_on_track: 1, dm_on_already_tracked: 1,
  });
  await db.query('DELETE FROM guild_streamer_auto_track WHERE guild_id=?', [GUILD]);
  await db.query(
    'INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, live_role_id, ping_role_id, min_level, enabled, delete_on_end, edit_on_end) VALUES (?,?,?,?,?,0,1,0,1)',
    [GUILD, R('streamer'), CH('live'), R('live'), R('ping_streams')])
    .catch(async (e) => {
      if (!/ping_role_id/.test(e.message)) throw e;
      await db.query(
        'INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, live_role_id, min_level, enabled, delete_on_end, edit_on_end) VALUES (?,?,?,?,0,1,0,1)',
        [GUILD, R('streamer'), CH('live'), R('live')]);
    });
  console.log('  guild_streamer_auto_track: 📡 Signal Caster -> #live-now');

  if (!IDS.panels.signup) {
    const embed = {
      title: '📡 Broadcast to the Hive',
      color: C.live,
      description: [
        'Stream on Twitch, Kick, YouTube, TikTok, Rumble or Facebook? Let the hive know when you go live.',
        '',
        '**1.** Hit **Add Me** and drop your channel link.',
        '**2.** You get the 📡 **Signal Caster** role.',
        `**3.** Every time you go live the hive broadcasts it in <#${CH('live')}>.`,
        '',
        `Or just paste your link in <#${CH('selfpromo')}> — the bot picks it up.`,
      ].join('\n'),
    };
    const row = { type: 1, components: [{ type: 2, style: 3, label: 'Add Me', custom_id: `selfpromo_join:${CH('live')}`, emoji: { name: '📡' } }] };
    const msg = await post(CH('streamsignup'), { embeds: [embed], components: [row] });
    IDS.panels.signup = msg.id; saveIds();
    console.log(`  signup panel: ${msg.id}`);
  } else console.log('  signup panel: exists');
  console.log('\nStreaming phase done.');
}

// ── AUTOMOD ──────────────────────────────────────────────────────────────────
async function phaseAutomod() {
  const existing = await rest('GET', `/guilds/${GUILD}/auto-moderation/rules`).catch(() => []);
  const have = new Set((Array.isArray(existing) ? existing : []).map((r) => r.name));
  const alert = { type: 2, metadata: { channel_id: CH('modalerts') } };
  const block = { type: 1, metadata: { custom_message: 'Blocked by the Hive AutoMod — check the protocol in #rules.' } };
  const exempt = [R('guard'), R('warden')].filter(Boolean);
  const rules = [
    { name: 'Hive • Spam', event_type: 1, trigger_type: 3, actions: [block, alert] },
    { name: 'Hive • Mention Spam', event_type: 1, trigger_type: 5, trigger_metadata: { mention_total_limit: 6, mention_raid_protection_enabled: true }, actions: [block, alert] },
    { name: 'Hive • Slurs', event_type: 1, trigger_type: 4, trigger_metadata: { presets: [3] }, actions: [block, alert] },
    { name: 'Hive • Invite Links', event_type: 1, trigger_type: 1, trigger_metadata: { regex_patterns: ['(discord\\.(gg|io|me|li)|discord(app)?\\.com/invite)/[a-zA-Z0-9-]+'] }, actions: [block, alert] },
  ];
  for (const r of rules) {
    if (have.has(r.name)) { console.log(`· ${r.name}: exists`); continue; }
    await rest('POST', `/guilds/${GUILD}/auto-moderation/rules`, { ...r, enabled: true, exempt_roles: exempt }, 'The Hive: automod');
    console.log(`· ${r.name}: created`); await sleep(450);
  }
  console.log('\nAutomod phase done.');
}

// ── FINALIZE: community mode, guild settings, announcement channel ───────────
async function phaseFinalize() {
  await refresh();
  const g = await rest('GET', `/guilds/${GUILD}`);
  const features = new Set(g.features);
  features.add('COMMUNITY');
  await rest('PATCH', `/guilds/${GUILD}`, {
    features: [...features],
    verification_level: Math.max(g.verification_level, 2), // must have a verified email + 5 min on Discord
    explicit_content_filter: 2,
    default_message_notifications: 1,
    rules_channel_id: CH('rules'),
    public_updates_channel_id: CH('updates'),
    safety_alerts_channel_id: CH('modalerts'),
    system_channel_id: CH('arrivals'),
    // suppress Discord's own join messages (the bot already welcomes), boost-premium + setup tips
    system_channel_flags: (1 << 0) | (1 << 1) | (1 << 3),
    afk_channel_id: CH('vcafk'), afk_timeout: 900,
    description: 'A hive mind for gamer brains. Cyberpunk bees, one network, many players.',
    preferred_locale: 'en-US',
  }, 'The Hive: community + guild settings');
  console.log('· guild: COMMUNITY on, rules/updates/safety channels, AFK, verification=medium, filter=all');
  await sleep(600);
  await refresh();
  const ann = guildChannels.find((c) => c.id === CH('announcements'));
  if (ann && ann.type !== 5) {
    await rest('PATCH', `/channels/${CH('announcements')}`, { type: 5 }, 'The Hive: announcement channel');
    console.log('· #announcements -> Announcement channel (auto-publish)');
  }
  console.log('\nFinalize phase done.');
}

// ── REORDER: colour picker above EVERYTHING (staff included) ──────────────────
// A picked colour must win for everyone; staff who don't pick keep their staff colour.
// On a fresh guild every role sits at position 1 (ties rank by id, so the bot is effectively on
// top). Including the bot's OWN role at the top of the PATCH works (200) and gives every role a
// real position; leaving it out would try to lift roles above it and fail with 50013.
async function phaseReorder() {
  await refresh();
  const known = new Set(ROLE_DEFS.map((d) => R(d.slug)));
  // anything the owner created by hand keeps its relative place at the bottom of our block
  const extra = guildRoles.filter((r) => !known.has(r.id) && !r.managed && r.id !== GUILD)
    .sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).map((r) => r.id);
  const ordered = [IDS.misc.botRole, ...ROLE_ORDER.map(R), ...extra].filter(Boolean);
  const payload = ordered.map((id, i) => ({ id, position: ordered.length - i }));
  await rest('PATCH', `/guilds/${GUILD}/roles`, payload, 'The Hive: grouped role order');
  await refresh();
  const top = [...guildRoles].sort((a, b) => b.position - a.position).slice(0, 16).map((r) => `${r.position}:${r.name}`);
  console.log(top.join(' | '));
}

// ── PRIMARY STREAMER: the_gaming_bee (server owner, Karabi's dad) ─────────────
// Gets his own announcement channel + schedule, separate from the community #live-now feed.
const PRIMARY_LOGIN = 'the_gaming_bee';
const PRIMARY_MSG = [
  '## 🐝 {streamer} is LIVE — {game}',
  '',
  "-# The hive's founder is broadcasting. All drones, report to the hive.",
  '',
  '**{title}**',
  '',
  '▶️ {url}',
].join('\n');

async function phasePrimary() {
  await refresh();
  // 1) streamer row
  const { getTwitchUser } = await import('../utils/platforms/twitch-api.js');
  const tu = await getTwitchUser(PRIMARY_LOGIN);
  if (!tu?.id) throw new Error(`could not resolve twitch user ${PRIMARY_LOGIN}`);
  console.log(`· twitch: ${tu.display_name || tu.login} id=${tu.id}`);
  let [[st]] = await db.query("SELECT streamer_id FROM streamers WHERE platform='twitch' AND platform_user_id=?", [String(tu.id)]);
  if (!st) {
    const [ins] = await db.query(
      'INSERT INTO streamers (platform, platform_user_id, username, normalized_username, profile_image_url) VALUES (?,?,?,?,?)',
      ['twitch', String(tu.id), tu.login, tu.login.toLowerCase(), tu.profile_image_url || null]);
    st = { streamer_id: ins.insertId };
    console.log(`  created streamer #${st.streamer_id}`);
  } else console.log(`  streamer exists #${st.streamer_id}`);
  IDS.misc.primaryStreamerId = st.streamer_id; saveIds();

  // 2) his channels lead the Broadcast category
  const cat = CAT('broadcast');
  const order = LAYOUT.find((c) => c.slug === 'broadcast').channels; // #bee-live + #stream-schedule lead it
  let pos = 0;
  for (const def of order) console.log(`    ${def[1].padEnd(28)} ${await ensureChannel(def, cat, pos++)}`);

  // 3) repurpose the unused "Stream Alerts" ping role as his go-live ping
  const pingName = 'Bee Live Alerts', pingLabel = 'Bee Goes Live';
  await ensureRole({ slug: 'ping_streams', name: pingName, color: 0 });
  const def = ROLE_DEFS.find((d) => d.slug === 'ping_streams');
  def.name = pingName; def.label = pingLabel; def.emoji = '🐝';
  await db.query(
    `UPDATE reaction_role_mappings m JOIN reaction_role_panels p ON p.id=m.panel_id
     SET m.label=?, m.emoji_id=? WHERE p.guild_id=? AND m.role_id=?`, [pingLabel, '🐝', GUILD, R('ping_streams')]);
  const pingItems = ROLE_DEFS.filter((d) => d.panel === 'pings').map((d) => [`rr_${R(d.slug)}`, d.label, d.emoji]);
  await rest('PATCH', `/channels/${CH('getroles')}/messages/${IDS.panels.pings}`, { components: buttonRows(pingItems) });
  console.log('· ping role -> "Bee Live Alerts", pings panel button updated');

  // 4) subscription -> #bee-live
  const cols = {
    announcement_channel_id: CH('beelive'), live_role_id: R('live'), ping_role_id: R('ping_streams'),
    custom_message: PRIMARY_MSG, edit_on_end: 1, paused: 0, permanent: 1, tracking_origin: 'external',
  };
  const [[sub]] = await db.query('SELECT subscription_id FROM subscriptions WHERE guild_id=? AND streamer_id=?', [GUILD, st.streamer_id]);
  if (sub) {
    await db.query(`UPDATE subscriptions SET ${Object.keys(cols).map((k) => `\`${k}\`=?`).join(',')} WHERE subscription_id=?`, [...Object.values(cols), sub.subscription_id]);
    console.log(`· subscription #${sub.subscription_id} -> #bee-live (updated)`);
  } else {
    const [ins] = await db.query(
      `INSERT INTO subscriptions (guild_id, streamer_id, ${Object.keys(cols).map((k) => `\`${k}\``).join(',')}) VALUES (?,?,${Object.keys(cols).map(() => '?').join(',')})`,
      [GUILD, st.streamer_id, ...Object.values(cols)]);
    console.log(`· subscription #${ins.insertId} -> #bee-live (created)`);
  }

  // 5) Twitch schedule sync -> #stream-schedule (Karabi's settings, remapped)
  await cloneOne('twitch_schedule_sync_config', {
    streamer_id: st.streamer_id, discord_channel_id: CH('schedule'), last_message_id: null, schedule_hash: null,
    previous_segments_json: null, last_synced: null, last_weekly_refresh: null, change_detected_at: null, mention_role_id: null,
  }, { drop: [] });

  // 6) point the welcome guide at his channel
  if (IDS.panels.guide) {
    const msg = await rest('GET', `/channels/${CH('welcome')}/messages/${IDS.panels.guide}`);
    const embed = msg.embeds[0];
    const line = `📡 **Broadcast** — <#${CH('beelive')}> for **The Gaming Bee**, plus hive members live now + stream signup`;
    const desc = embed.description.split('\n').map((l) => (l.startsWith('📡 **Broadcast**') ? line : l)).join('\n');
    const withHost = desc.replace('**A hive mind for gamer brains.**',
      `**A hive mind for gamer brains**, home of [the_gaming_bee](https://www.twitch.tv/${PRIMARY_LOGIN}).`);
    if (withHost !== embed.description) {
      await rest('PATCH', `/channels/${CH('welcome')}/messages/${IDS.panels.guide}`, { embeds: [{ ...embed, description: withHost }] });
      console.log('· welcome guide updated');
    }
  }
  console.log('\nPrimary streamer phase done. EventSub picks him up on the next reconcile (<=30 min).');
}

async function phaseVerify() {
  await refresh();
  const g = await rest('GET', `/guilds/${GUILD}`);
  console.log(`guild: community=${g.features.includes('COMMUNITY')} rules=${g.rules_channel_id} updates=${g.public_updates_channel_id} afk=${g.afk_channel_id}`);
  const [[vc]] = await db.query('SELECT * FROM verify_config WHERE guild_id=?', [GUILD]);
  console.log(`verify: role=${vc?.verified_role_id} gate_msg=${vc?.gate_message_id}`);
  const [pan] = await db.query('SELECT panel_name, panel_mode FROM reaction_role_panels WHERE guild_id=?', [GUILD]);
  console.log(`rr panels: ${pan.map((p) => `${p.panel_name}(${p.panel_mode})`).join(' | ')}`);
  const [tp] = await db.query('SELECT panel_id, panel_name, panel_message_id FROM ticket_panels WHERE guild_id=?', [GUILD]);
  console.log(`ticket panels: ${tp.map((t) => `${t.panel_name}#${t.panel_id}`).join(', ')}`);
  const [lr] = await db.query('SELECT level, role_id FROM level_role_rewards WHERE guild_id=? ORDER BY level', [GUILD]);
  console.log(`level rewards: ${lr.map((l) => l.level).join(',')}`);
  const am = await rest('GET', `/guilds/${GUILD}/auto-moderation/rules`).catch(() => []);
  console.log(`automod: ${(am || []).map((r) => r.name).join(', ')}`);
  // colour picker must outrank every coloured non-staff role a member can hold
  const byId = Object.fromEntries(guildRoles.map((r) => [r.id, r]));
  const pickerLow = Math.min(...ROLE_DEFS.filter((d) => d.panel === 'colour').map((d) => byId[R(d.slug)].position));
  const staff = new Set(['queen', 'guard', 'warden', 'tech', 'live', 'hatchday'].map(R));
  const beats = guildRoles.filter((r) => r.color && !r.managed && !staff.has(r.id) && r.position > pickerLow && !ROLE_DEFS.some((d) => d.panel === 'colour' && R(d.slug) === r.id));
  console.log(beats.length ? `⚠️ coloured roles above picker: ${beats.map((r) => r.name).join(', ')}` : '✅ colour picker outranks every member-held coloured role');
  const botRole = byId[IDS.misc.botRole];
  const above = guildRoles.filter((r) => r.position >= botRole.position && r.id !== botRole.id && r.id !== GUILD);
  console.log(above.length ? `⚠️ roles at/above the bot: ${above.map((r) => `${r.name}@${r.position}`).join(', ')} (bot @${botRole.position})` : `✅ bot role is on top (@${botRole.position})`);
  const bad = guildChannels.filter((c) => [...c.name].some((ch) => !/\p{Assigned}/u.test(ch)));
  console.log(bad.length ? `⚠️ unassigned codepoints in: ${bad.map((c) => c.id).join(',')}` : '✅ all channel names use assigned codepoints');
  console.log(`\ntotals: ${guildRoles.length} roles, ${guildChannels.length} channels`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────
const phase = process.argv[2] || 'show';
const PHASES = { preflight: phasePreflight, roles: phaseRoles, channels: phaseChannels, config: phaseConfig, panels: phasePanels,
  streaming: phaseStreaming, primary: phasePrimary, reorder: phaseReorder, automod: phaseAutomod, finalize: phaseFinalize, verify: phaseVerify };
try {
  if (PHASES[phase]) await PHASES[phase]();
  else if (phase === 'show') console.log(JSON.stringify(IDS, null, 2));
  else console.log(`unknown phase: ${phase}`);
} catch (e) {
  console.error('PHASE FAILED:', e.message);
  saveIds(); await db.end(); process.exit(1);
}
saveIds();
await db.end();
process.exit(0);
