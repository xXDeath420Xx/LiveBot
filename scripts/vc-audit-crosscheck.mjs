/*
 * Cross-checks the voice_activity table against the mod-log's own voice embeds.
 *
 * voice_activity is the authoritative source for the audit — it stores real session
 * durations, which the log does not (a "moved voice channels" embed does not even name the
 * destination). But a DB table only knows what the bot was up to record: if the listener
 * was down for a fortnight, the table is silently short and nothing about it looks wrong.
 * The mod-log is written by a different path, so comparing daily join counts between the
 * two is a genuine check rather than a restatement.
 *
 *   node scripts/vc-audit-crosscheck.mjs <guildId> <botId> <modLogChannelId> [--days 90]
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import enc from '../utils/encryption.js';
import { writeFileSync } from 'node:fs';

const [GUILD, BOT, LOGCH] = process.argv.slice(2);
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const DAYS = Number(arg('--days', 90));
const OUT = arg('--out', `/tmp/vc-crosscheck-${GUILD}.json`);
const CUTOFF = Date.now() - DAYS * 86400000;

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[row]] = await db.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT]);
const token = enc.decrypt(JSON.parse(row.bot_token));

const api = async (p) => {
  const r = await fetch('https://discord.com/api/v10' + p, { headers: { Authorization: `Bot ${token}` } });
  if (r.status === 429) { const j = await r.json(); await new Promise(s => setTimeout(s, (j.retry_after ?? 1) * 1000 + 250)); return api(p); }
  if (!r.ok) throw new Error(`${r.status} ${p}`);
  return r.json();
};

// ── log side ────────────────────────────────────────────────────────────────
const logJoinsByDay = new Map();
const logEvents = { join: 0, leave: 0, move: 0 };
let before = null, scanned = 0;
for (;;) {
  const page = await api(`/channels/${LOGCH}/messages?limit=100${before ? `&before=${before}` : ''}`);
  if (!page.length) break;
  let done = false;
  for (const m of page) {
    const ts = Date.parse(m.timestamp);
    if (ts < CUTOFF) { done = true; continue; }
    scanned++;
    const t = m.embeds?.[0]?.title ?? '';
    if (!t.includes('Voice Channel')) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    if (t.includes('Join')) { logEvents.join++; logJoinsByDay.set(day, (logJoinsByDay.get(day) ?? 0) + 1); }
    else if (t.includes('Leave')) logEvents.leave++;
    else if (t.includes('Move')) logEvents.move++;
  }
  if (done || page.length < 100) break;
  before = page[page.length - 1].id;
}

// ── db side ─────────────────────────────────────────────────────────────────
const [dbDaily] = await db.execute(
  `SELECT DATE(joined_at) d, COUNT(*) n FROM voice_activity
   WHERE guild_id = ? AND joined_at > FROM_UNIXTIME(?) GROUP BY d ORDER BY d`,
  [GUILD, Math.floor(CUTOFF / 1000)]
);
await db.end();

const dbByDay = new Map(dbDaily.map(r => [r.d.toISOString().slice(0, 10), Number(r.n)]));
const allDays = [...new Set([...dbByDay.keys(), ...logJoinsByDay.keys()])].sort();

const gaps = [];
for (const d of allDays) {
  const dbN = dbByDay.get(d) ?? 0, logN = logJoinsByDay.get(d) ?? 0;
  // A day the log saw joins on but the table recorded none is the failure mode that matters.
  if (logN > 0 && dbN === 0) gaps.push({ day: d, log: logN, db: 0 });
}

const dbTotal = [...dbByDay.values()].reduce((a, b) => a + b, 0);
console.log(`log messages scanned in window : ${scanned}`);
console.log(`log voice events               : ${logEvents.join} join / ${logEvents.leave} leave / ${logEvents.move} move`);
console.log(`voice_activity sessions        : ${dbTotal}`);
console.log(`days with log joins but no DB rows : ${gaps.length}`);
for (const g of gaps) console.log(`   ${g.day}: log ${g.log} joins, DB 0`);
console.log(`log-covered days ${Math.min(...logJoinsByDay.keys())} → ${Math.max(...logJoinsByDay.keys())}`);
writeFileSync(OUT, JSON.stringify({ logEvents, dbTotal, gaps, days: allDays.length }, null, 1));
console.log('->', OUT);
process.exit(0);
