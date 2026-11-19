/*
 * Team Aura (twitch.tv/team/auragg) — duplicate of the "ReeferRealm Team Stuff" category in
 * guild 985116833193553930, run by the ReeferRealm custom bot (resolved, never pinned).
 *
 *   node scripts/setup-team-aura.mjs [--dry]
 *
 * Builds: a "Team Aura Live" role (clone of Reefer Realm Live), the category + its 4 channels
 * with the source overwrites copied, a private app-log channel under Bot Logs, a twitch_teams
 * row for auragg, and an application form + ticket panel posted in #team-application.
 * Idempotent: ids persist in scripts/.teamaura-setup-ids.json; reruns reuse what exists.
 * REST-only via the custom bot token (safe while PM2 runs — no gateway login).
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const DRY = process.argv.includes('--dry');
const GUILD = '985116833193553930';
const SRC_CATEGORY = '1347153712661135360';  // 🔴🔴ReeferRealm Team Stuff🔴🔴
const SRC = {
  live: '1415373602068496545',          // teammates-live💖 (announcement)
  apply: '1347152322530250833',         // reeferrealm-applications✍
  logos: '1347194826336243712',         // reeferrealm-logos™
  ranking: '1347195958277967952',       // reeferrealm-ranking☝
};
const SRC_LIVE_ROLE = '1415371559966609552'; // Reefer Realm Live
const BOT_LOGS_CATEGORY = '1467848920464883875';
const ADMINISTRATION = '1347134428664827966'; // leadership — reviews applications
const OWNER = '515952792226234390';           // theflickmaster (FLiiQzy), guild owner
const TEAM = 'auragg';
const TEAM_URL = 'https://www.twitch.tv/team/auragg';
const TEAM_LOGO = 'https://static-cdn.jtvnw.net/team-assets/auragg-bc06c0598d1b4c0fa873d0a509accb37.png';
const AURA_RED = 0xB3122E;

const NAMES = {
  category: '🌌🌌Team Aura Stuff🌌🌌',
  live: 'teamaura-live💖',
  apply: 'team-application✍',   // the Twitch team page sends applicants to #team-application
  logos: 'teamaura-logos™',
  ranking: 'teamaura-ranking☝',
  appLogs: 'teamaura-app-logs',
  role: 'Team Aura Live',
};

const IDS_PATH = new URL('./.teamaura-setup-ids.json', import.meta.url);
const ids = existsSync(IDS_PATH) ? JSON.parse(readFileSync(IDS_PATH, 'utf8')) : {};
const save = () => { if (!DRY) writeFileSync(IDS_PATH, JSON.stringify(ids, null, 2) + '\n'); };

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME, charset: 'utf8mb4',
});
const bot = await resolveBotForGuild(GUILD, { db });
// A top-level-await rejection with the DB handle open hangs silently instead of exiting.
process.on('unhandledRejection', (e) => { console.error('FAILED:', e?.message ?? e); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asciiReason = (s) => s.replace(/[^\x20-\x7E]/g, '').slice(0, 300);

async function rest(method, path, body, reason) {
  if (DRY && method !== 'GET') { console.log('[dry]', method, path, body ? JSON.stringify(body).slice(0, 200) : ''); return { id: `dry-${path}` }; }
  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = { Authorization: `Bot ${bot.token}` };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    if (reason) headers['X-Audit-Log-Reason'] = asciiReason(reason);
    const res = await fetch(`https://discord.com/api/v10${path}`, { method, headers, body: payload });
    if (process.env.TRACE) console.log(method, path, res.status);
    if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep((j.retry_after ?? 1) * 1000 + 250); continue; }
    if (res.status === 204) return null;
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(j)}`);
    return j;
  }
  throw new Error(`${method} ${path} rate-limited out`);
}

const REASON = 'Team Aura (auragg) team channels, cloned from ReeferRealm Team Stuff';
const channels = await rest('GET', `/guilds/${GUILD}/channels`);
const roles = await rest('GET', `/guilds/${GUILD}/roles`);
const byId = (id) => channels.find((c) => c.id === id);
const existing = (key, parentId) =>
  (ids[key] && channels.find((c) => c.id === ids[key])) ||
  channels.find((c) => c.name === NAMES[key] && (parentId === undefined || c.parent_id === parentId));
const cloneOverwrites = (c) => c.permission_overwrites.map(({ id, type, allow, deny }) => ({ id, type, allow, deny }));

// ── 1. live role ─────────────────────────────────────────────────────────────
const srcRole = roles.find((r) => r.id === SRC_LIVE_ROLE);
let role = (ids.role && roles.find((r) => r.id === ids.role)) || roles.find((r) => r.name === NAMES.role);
if (!role) {
  role = await rest('POST', `/guilds/${GUILD}/roles`, {
    name: NAMES.role, permissions: '0', hoist: srcRole.hoist, mentionable: srcRole.mentionable,
    // Solid colour: the guild lost ENHANCED_ROLE_COLORS, a gradient 403s (670006).
    color: AURA_RED,
  }, REASON);
  // Sit directly above Reefer Realm Live so both live roles hoist together.
  await rest('PATCH', `/guilds/${GUILD}/roles`, [{ id: role.id, position: srcRole.position + 1 }], REASON);
  console.log('created role', role.id);
} else console.log('role exists', role.id);
ids.role = role.id; save();

// ── 2. category, placed right after the ReeferRealm one ──────────────────────
const srcCat = byId(SRC_CATEGORY);
let cat = existing('category');
if (!cat) {
  cat = await rest('POST', `/guilds/${GUILD}/channels`, {
    name: NAMES.category, type: 4, permission_overwrites: cloneOverwrites(srcCat),
  }, REASON);
  const cats = channels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position);
  const order = [];
  for (const c of cats) { order.push(c.id); if (c.id === SRC_CATEGORY) order.push(cat.id); }
  await rest('PATCH', `/guilds/${GUILD}/channels`, order.map((id, i) => ({ id, position: i })), REASON);
  console.log('created category', cat.id);
} else console.log('category exists', cat.id);
ids.category = cat.id; save();

// ── 3. the four channels, overwrites copied from their ReeferRealm twins ─────
for (const key of ['live', 'apply', 'logos', 'ranking']) {
  const src = byId(SRC[key]);
  let ch = existing(key, cat.id);
  if (!ch) {
    ch = await rest('POST', `/guilds/${GUILD}/channels`, {
      name: NAMES[key], type: src.type, parent_id: cat.id,
      topic: key === 'ranking'
        ? '* **Our Current 30 Day Ranking for Most Watched Stream Teams on Twitch.** *'
        : key === 'apply' ? `Apply to join 𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 on Twitch — ${TEAM_URL}` : (src.topic ?? undefined),
      nsfw: src.nsfw, rate_limit_per_user: src.rate_limit_per_user,
      permission_overwrites: cloneOverwrites(src),
    }, REASON);
    console.log('created', key, ch.id, NAMES[key]);
  } else console.log(key, 'exists', ch.id);
  ids[key] = ch.id; save();
}

// ── 4. private application log/alert channel (leadership + bot) ──────────────
let appLogs = existing('appLogs', BOT_LOGS_CATEGORY);
if (!appLogs) {
  appLogs = await rest('POST', `/guilds/${GUILD}/channels`, {
    name: NAMES.appLogs, type: 0, parent_id: BOT_LOGS_CATEGORY,
    topic: 'New Team Aura applications + closed-ticket transcripts (leadership only).',
    permission_overwrites: [
      { id: GUILD, type: 0, allow: '0', deny: '1024' },
      { id: ADMINISTRATION, type: 0, allow: '66560', deny: '0' },
      { id: bot.botId, type: 1, allow: '537316352', deny: '0' }, // view/send/embed/attach/history
    ],
  }, REASON);
  console.log('created app-logs', appLogs.id);
}
ids.appLogs = appLogs.id; save();

// ── 5. starter content: logo + ranking link ──────────────────────────────────
if (!ids.logoMessage) {
  const png = await fetch(TEAM_LOGO).then((r) => r.arrayBuffer());
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ content: '𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 — official team logo (from the Twitch team page)' }));
  fd.append('files[0]', new Blob([png], { type: 'image/png' }), 'TeamAura_logo.png');
  ids.logoMessage = (await rest('POST', `/channels/${ids.logos}/messages`, fd))?.id; save();
}
if (!ids.rankingMessage) {
  ids.rankingMessage = (await rest('POST', `/channels/${ids.ranking}/messages`, {
    content: 'https://streamscharts.com/teams/auragg',
  }))?.id; save();
}

// ── 6. twitch team sync → live channel + live role ───────────────────────────
const [[team]] = await db.query('SELECT id FROM twitch_teams WHERE guild_id = ? AND team_name = ?', [GUILD, TEAM]);
if (team) {
  if (!DRY) await db.query('UPDATE twitch_teams SET announcement_channel_id = ?, live_role_id = ? WHERE id = ?', [ids.live, role.id, team.id]);
  ids.twitchTeam = team.id;
} else if (!DRY) {
  const [r] = await db.query('INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id, live_role_id) VALUES (?, ?, ?, ?)', [GUILD, TEAM, ids.live, role.id]);
  ids.twitchTeam = r.insertId;
}
console.log('twitch_teams', ids.twitchTeam); save();

// ── 7. application form + ticket panel ───────────────────────────────────────
const FORM_NAME = 'Team Aura Application';
const QUESTIONS = [
  // [question_text, field_label (≤45), type, placeholder (≤100)]
  ['Your Twitch channel URL', 'Twitch channel URL', 'text', 'https://twitch.tv/yourname'],
  ['What do you stream, and what is your usual schedule?', 'What you stream + your schedule', 'paragraph', 'Games/categories, days and times you go live'],
  ['Why do you want to join Team Aura?', 'Why do you want to join Team Aura?', 'paragraph', null],
  ['Anything else we should know? (socials, other teams you are on, etc.)', 'Anything else? (socials, other teams…)', 'paragraph', null],
];
let [[form]] = await db.query('SELECT form_id FROM ticket_forms WHERE guild_id = ? AND form_name = ?', [GUILD, FORM_NAME]);
if (!form && !DRY) {
  const [f] = await db.query(
    'INSERT INTO ticket_forms (guild_id, form_name, form_description, submit_channel_id) VALUES (?, ?, ?, ?)',
    [GUILD, FORM_NAME, `Application to join 𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 (${TEAM_URL})`, ids.appLogs]);
  form = { form_id: f.insertId };
  for (const [i, [text, label, type, ph]] of QUESTIONS.entries()) {
    await db.query(
      `INSERT INTO ticket_form_questions (form_id, question_text, field_label, question_type, is_required, placeholder, question_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [form.form_id, text, label, type, i < 3 ? 1 : 0, ph, i]);
  }
  console.log('created form', form.form_id);
}
ids.formId = form?.form_id; save();

const PANEL_NAME = 'Team Aura Applications';
const DESCRIPTION =
  `Looking to join the **𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊** stream team on Twitch? Built on good vibes, genuine passion, and a shared drive to create.\n\n` +
  `**What we expect**\n` +
  `• **Stay active & engaged** — stream consistently, network, and support your teammates\n` +
  `• **Positive culture** — champion your peers and collaborate across streams\n` +
  `• **Platform integrity** — follow Twitch's Terms of Service and Community Guidelines\n\n` +
  `Tap **Apply to join** below to fill out a short application. It opens a **private ticket** that only you and the leadership team can see — <@${OWNER}> and the team will review it and send an invite from there.\n\n` +
  `🔗 [Team page](${TEAM_URL})`;
let [[panel]] = await db.query('SELECT panel_id, panel_message_id FROM ticket_panels WHERE guild_id = ? AND panel_name = ?', [GUILD, PANEL_NAME]);
if (!panel && !DRY) {
  const [p] = await db.query(
    `INSERT INTO ticket_panels
       (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color,
        button_text, button_emoji, ticket_category_id, support_role_id, extra_viewer_id, form_id,
        ticket_name_format, save_transcripts, log_channel_id, alert_channel_id, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`,
    [GUILD, PANEL_NAME, ids.apply, '𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 — Team Applications', DESCRIPTION,
      '#' + AURA_RED.toString(16).padStart(6, '0'), 'Apply to join', '🌌', ids.category,
      ADMINISTRATION, OWNER, form.form_id, 'aura-app-{username}', ids.appLogs, ids.appLogs]);
  panel = { panel_id: p.insertId, panel_message_id: null };
  console.log('created panel', panel.panel_id);
}
ids.panelId = panel?.panel_id; save();

if (panel && !panel.panel_message_id) {
  const msg = await rest('POST', `/channels/${ids.apply}/messages`, {
    embeds: [{
      author: { name: 'Team Aura Application' },
      title: '𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 — Team Applications',
      description: DESCRIPTION, color: AURA_RED, thumbnail: { url: TEAM_LOGO },
    }],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Apply to join', emoji: { name: '🌌' }, custom_id: `ticket_create_panel_${panel.panel_id}` }] }],
  });
  if (!DRY) await db.query('UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [msg.id, panel.panel_id]);
  ids.panelMessage = msg.id; save();
  console.log('posted panel', msg.id);
}

console.log(JSON.stringify(ids, null, 2));
await db.end();
