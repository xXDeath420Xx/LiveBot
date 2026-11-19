/*
 * 𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 (985116833193553930): take the two MEE6 ticket panels over onto the guild's own bot.
 *   • #contact-staff📝   "Support Requests" → ticket panel, MODERATORS + Server Admin (as MEE6 had)
 *   • #reeferrealm-applications✍ "ReeferRealm Application" → form + panel shaped like Team Aura's (44)
 * Reuses MEE6's empty "Closed Tickets" category as the support-ticket category, adds
 * #ticket-logs and #reeferrealm-app-logs under Bot Logs (overwrites mirror #teamaura-app-logs),
 * posts our panels, then deletes MEE6's panel messages (archived in archives/teamaura-mee6-…/).
 * Idempotent: everything is looked up by name/panel_name first.
 *   node scripts/setup-teamaura-ticket-takeover.mjs [--dry]
 * REST-only via the resolved custom bot token (safe while PM2 runs).
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const DRY = process.argv.includes('--dry');
const G = '985116833193553930';
const MEE6 = '1347110732520493056'; // bot-id-ok: the third-party bot being retired, not one of ours
const OWNER = '515952792226234390';
const ROLES = { moderators: '1063272196878901390', serverAdmin: '1408002415034110033', administration: '1347134428664827966' };
const CH = { contactStaff: '1347122912989286472', reeferApply: '1347152322530250833', closedTickets: '1347135653279957073',
  botLogs: '1467848920464883875', auraAppLogs: '1555194883604480030', reeferCategory: '1347153712661135360' };
const OLD_PANELS = { [CH.contactStaff]: '1408933958510706708', [CH.reeferApply]: '1448626439363625066' };
const AURA_RED = 0xB3122E;
const REEFER_LOGO = 'https://certifriedmultitool.com/uploads/reeferrealm_logo_985116833193553930.png';

const db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, charset: 'utf8mb4' });
process.on('unhandledRejection', (e) => { console.error('FAILED:', e?.message ?? e); process.exit(1); });
const bot = await resolveBotForGuild(G, { db });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(method, path, body) {
  if (DRY && method !== 'GET') { console.log('[dry]', method, path, body ? JSON.stringify(body).slice(0, 160) : ''); return { id: `dry-${path.split('/').pop()}` }; }
  for (let a = 0; a < 6; a++) {
    const headers = { Authorization: `Bot ${bot.token}`, 'X-Audit-Log-Reason': 'Retire MEE6: ticket panels moved to TeamAura Utility' };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`https://discord.com/api/v10${path}`, { method, headers, body: body && JSON.stringify(body) });
    if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep((j.retry_after ?? 1) * 1000 + 250); continue; }
    if (res.status === 204) return null;
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(j)}`);
    return j;
  }
  throw new Error(`${method} ${path} rate-limited out`);
}
const channels = await rest('GET', `/guilds/${G}/channels`);
const auraLogs = channels.find((c) => c.id === CH.auraAppLogs);
const logOverwrites = auraLogs.permission_overwrites.map(({ id, type, allow, deny }) => ({ id, type, allow, deny }));

// ── 1. support-ticket category: MEE6's empty "Closed Tickets", renamed, MEE6's overwrite dropped
const cat = channels.find((c) => c.id === CH.closedTickets);
if (channels.some((c) => c.parent_id === cat.id)) throw new Error('Closed Tickets is not empty — check by hand');
await rest('PATCH', `/channels/${cat.id}`, {
  name: '🎫🎫 Support Tickets 🎫🎫',
  permission_overwrites: cat.permission_overwrites.filter((o) => o.id !== MEE6)
    .concat(cat.permission_overwrites.some((o) => o.id === ROLES.serverAdmin) ? [] : [{ id: ROLES.serverAdmin, type: 0, allow: '68608', deny: '0' }])
    .map(({ id, type, allow, deny }) => ({ id, type, allow, deny })),
});
console.log('category ready', cat.id);

// ── 2. log channels under Bot Logs
async function logChannel(name, topic) {
  const have = channels.find((c) => c.name === name && c.parent_id === CH.botLogs);
  if (have) { console.log('log channel exists', name, have.id); return have.id; }
  const c = await rest('POST', `/guilds/${G}/channels`, { name, type: 0, parent_id: CH.botLogs, topic, permission_overwrites: logOverwrites });
  console.log('created', name, c.id); return c.id;
}
const ticketLogs = await logChannel('ticket-logs', 'Support ticket alerts + closed-ticket transcripts (leadership only).');
const reeferLogs = await logChannel('reeferrealm-app-logs', 'New ReeferRealm applications + closed-ticket transcripts (leadership only).');
// The mirrored overwrites only let Administration in; support tickets are worked by MODERATORS.
if (!DRY) await rest('PUT', `/channels/${ticketLogs}/permissions/${ROLES.moderators}`, { type: 0, allow: '66560', deny: '0' });

// ── 3. ReeferRealm application form (questions = Team Aura form 11's, team name swapped)
const FORM_NAME = 'ReeferRealm Application';
let [[form]] = await db.query('SELECT form_id FROM ticket_forms WHERE guild_id = ? AND form_name = ?', [G, FORM_NAME]);
if (!form && !DRY) {
  const [f] = await db.execute('INSERT INTO ticket_forms (guild_id, form_name, form_description, submit_channel_id) VALUES (?, ?, ?, ?)',
    [G, FORM_NAME, 'Application to join the ReeferRealm stream team on Twitch', reeferLogs]);
  form = { form_id: f.insertId };
  const [qs] = await db.query('SELECT * FROM ticket_form_questions WHERE form_id = 11 ORDER BY question_order');
  for (const q of qs) await db.execute(
    `INSERT INTO ticket_form_questions (form_id, question_text, field_label, question_type, question_options, is_required, placeholder, question_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [form.form_id, q.question_text.replace('Team Aura', 'ReeferRealm'), q.field_label.replace('Team Aura', 'ReeferRealm'),
      q.question_type, q.question_options, q.is_required, q.placeholder, q.question_order]);
  console.log('created form', form.form_id, `(${qs.length} questions)`);
} else console.log('form', form?.form_id ?? '(dry)');

// ── 4. panels
const PANELS = [
  { name: 'Support Requests', channel: CH.contactStaff, title: 'How can we help?', author: 'Support Requests',
    description: 'Welcome to our tickets channel. If you have any questions or inquiries, please click on the **Open ticket** button below to contact the staff!',
    button: 'Open ticket', emoji: '📩', style: 1, category: cat.id, support: ROLES.moderators, extra: ROLES.serverAdmin,
    form: null, format: 'ticket-{username}', logs: ticketLogs, thumbnail: null },
  { name: 'ReeferRealm Applications', channel: CH.reeferApply, title: 'ReeferRealm — Team Applications', author: 'ReeferRealm Application',
    description: `If you're looking to join the ⁴²⁰𝑅𝑒𝑒𝒇𝑒𝓇 𝑅𝑒𝒶𝓁𝓂⁷¹⁰ stream team on Twitch, tap **Create App** below to fill out a short application. It opens a **private ticket** that only you and the leadership team can see — <@${OWNER}> will respond / send an invite as soon as he's available / sees this ticket :)`,
    button: 'Create App', emoji: '📩', style: 3, category: CH.reeferCategory, support: ROLES.administration, extra: OWNER,
    form: form?.form_id ?? null, format: 'reefer-app-{username}', logs: reeferLogs, thumbnail: REEFER_LOGO },
];
for (const p of PANELS) {
  let [[row]] = await db.query('SELECT panel_id, panel_message_id FROM ticket_panels WHERE guild_id = ? AND panel_name = ?', [G, p.name]);
  if (!row && !DRY) {
    const [r] = await db.execute(
      `INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color,
         button_text, button_emoji, ticket_category_id, support_role_id, extra_viewer_id, form_id,
         ticket_name_format, save_transcripts, log_channel_id, alert_channel_id, is_active)
       VALUES (?, ?, ?, ?, ?, '#b3122e', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`,
      [G, p.name, p.channel, p.title, p.description, p.button, p.emoji, p.category, p.support, p.extra, p.form, p.format, p.logs, p.logs]);
    row = { panel_id: r.insertId, panel_message_id: null };
    console.log('created panel', row.panel_id, p.name);
  }
  if (row && !row.panel_message_id) {
    const msg = await rest('POST', `/channels/${p.channel}/messages`, {
      embeds: [{ author: { name: p.author }, title: p.title, description: p.description, color: AURA_RED, ...(p.thumbnail && { thumbnail: { url: p.thumbnail } }) }],
      components: [{ type: 1, components: [{ type: 2, style: p.style, label: p.button, emoji: { name: p.emoji }, custom_id: `ticket_create_panel_${row.panel_id}` }] }],
      allowed_mentions: { parse: [] },
    });
    if (!DRY) await db.query('UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [msg.id, row.panel_id]);
    console.log('posted panel', p.name, msg.id);
  } else console.log('panel already posted', p.name, row?.panel_message_id ?? '(dry)');
  // MEE6's panel goes only once ours is up
  const old = OLD_PANELS[p.channel];
  const stillThere = await rest('GET', `/channels/${p.channel}/messages?limit=50`);
  if (stillThere.some((m) => m.id === old)) { await rest('DELETE', `/channels/${p.channel}/messages/${old}`); console.log('deleted MEE6 panel', old); }
}
await db.end();
console.log('done');
