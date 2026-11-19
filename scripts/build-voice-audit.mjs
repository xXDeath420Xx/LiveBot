/*
 * Voice-activity companion to the 90-day message census.
 *
 *   node scripts/build-voice-audit.mjs <guildId> <botId> [--days 90] [--census f.json] [--out f.json]
 *
 * Source is the voice_activity table, not the mod-log: the log records that someone moved
 * channels but not where to or for how long, whereas the table stores real session
 * durations. scripts/vc-audit-crosscheck.mjs is what establishes the table has no gaps.
 *
 * Bots are resolved and excluded. This is not optional bookkeeping — a music bot parked in
 * a voice channel accumulates more hours than any human in the guild, so leaving them in
 * would put a bot at the top of an activity audit.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import enc from '../utils/encryption.js';
import { readFileSync, writeFileSync } from 'node:fs';

const [GUILD, BOT] = process.argv.slice(2);
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const DAYS = Number(arg('--days', 90));
const CENSUS = arg('--census', null);
const OUT = arg('--out', `/tmp/voice-audit-${GUILD}.json`);

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[row]] = await db.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT]);
const token = enc.decrypt(JSON.parse(row.bot_token));

const api = async (p) => {
  const r = await fetch('https://discord.com/api/v10' + p, { headers: { Authorization: `Bot ${token}` } });
  if (r.status === 429) { const j = await r.json(); await new Promise(s => setTimeout(s, (j.retry_after ?? 1) * 1000 + 250)); return api(p); }
  if (!r.ok) throw new Error(`${r.status} on ${p}: ${await r.text()}`);
  return r.json();
};

// ── per-user voice totals ───────────────────────────────────────────────────
const [rows] = await db.execute(
  `SELECT user_id,
          COUNT(*)                      AS sessions,
          SUM(duration)                 AS seconds,
          MAX(duration)                 AS longest,
          COUNT(DISTINCT channel_id)    AS channels,
          MIN(joined_at)                AS firstSeen,
          MAX(joined_at)                AS lastSeen,
          SUM(duration < 60)            AS underAMinute
     FROM voice_activity
    WHERE guild_id = ? AND joined_at > DATE_SUB(NOW(), INTERVAL ? DAY)
    GROUP BY user_id`,
  [GUILD, DAYS]
);
await db.end();

// ── resolve identities, split humans from bots ──────────────────────────────
const members = new Map();
let after = '0';
for (;;) {
  const page = await api(`/guilds/${GUILD}/members?limit=1000&after=${after}`);
  for (const m of page) members.set(m.user.id, m);
  if (page.length < 1000) break;
  after = page[page.length - 1].user.id;
}

const humans = [], bots = [], departed = [];
for (const r of rows) {
  const m = members.get(r.user_id);
  const entry = {
    id: r.user_id,
    displayName: m ? (m.nick || m.user.global_name || m.user.username) : null,
    username: m ? m.user.username : null,
    sessions: Number(r.sessions),
    seconds: Number(r.seconds),
    hours: +(Number(r.seconds) / 3600).toFixed(1),
    longestHours: +(Number(r.longest) / 3600).toFixed(1),
    channels: Number(r.channels),
    underAMinute: Number(r.underAMinute),
    firstSeen: new Date(r.firstSeen).toISOString(),
    lastSeen: new Date(r.lastSeen).toISOString(),
  };
  // A member who has since left the guild cannot be resolved to a name. They still spent
  // the time, so they are reported separately rather than silently dropped.
  if (!m) departed.push(entry);
  else if (m.user.bot) bots.push(entry);
  else humans.push(entry);
}
humans.sort((a, b) => b.seconds - a.seconds);
bots.sort((a, b) => b.seconds - a.seconds);
departed.sort((a, b) => b.seconds - a.seconds);

// ── merge with the message census, if supplied ──────────────────────────────
let combined = null;
if (CENSUS) {
  const census = JSON.parse(readFileSync(CENSUS));
  const byId = new Map(census.posters.map(p => [p.id, p]));
  const voiceById = new Map(humans.map(v => [v.id, v]));

  combined = [...new Set([...byId.keys(), ...voiceById.keys()])].map(id => {
    const t = byId.get(id), v = voiceById.get(id);
    return {
      id,
      displayName: t?.displayName ?? v?.displayName ?? null,
      username: t?.username ?? v?.username ?? null,
      messages: t?.messages ?? 0,
      voiceHours: v?.hours ?? 0,
      voiceSessions: v?.sessions ?? 0,
    };
  }).sort((a, b) => (b.messages + b.voiceHours * 10) - (a.messages + a.voiceHours * 10));
}

const totalHuman = humans.reduce((s, h) => s + h.seconds, 0);
const report = {
  guild: GUILD,
  window: { days: DAYS, to: new Date().toISOString() },
  totals: {
    humanVoiceUsers: humans.length,
    humanHours: +(totalHuman / 3600).toFixed(1),
    humanSessions: humans.reduce((s, h) => s + h.sessions, 0),
    botVoiceUsers: bots.length,
    botHoursExcluded: +(bots.reduce((s, b) => s + b.seconds, 0) / 3600).toFixed(1),
    departedVoiceUsers: departed.length,
    departedHours: +(departed.reduce((s, d) => s + d.seconds, 0) / 3600).toFixed(1),
  },
  voice: humans,
  botsExcluded: bots,
  departed,
  combined,
};
writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log(`humans in voice : ${humans.length}  (${report.totals.humanHours} h over ${report.totals.humanSessions} sessions)`);
console.log(`bots excluded   : ${bots.length}  (${report.totals.botHoursExcluded} h)`);
bots.forEach(b => console.log(`    ${String(b.hours).padStart(7)} h  ${b.displayName} (@${b.username})`));
console.log(`left the guild  : ${departed.length}  (${report.totals.departedHours} h)`);
console.log('->', OUT);
process.exit(0);
