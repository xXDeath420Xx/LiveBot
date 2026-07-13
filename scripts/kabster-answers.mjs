/*
 * Read back what the server owner has answered on her questionnaire.
 *
 *   node scripts/kabster-answers.mjs                 # Kabster's guild
 *   node scripts/kabster-answers.mjs <guildId>
 *   node scripts/kabster-answers.mjs --link          # print (or mint) her link
 *
 * She has no dashboard account, so the answers land in the DB rather than anywhere she can be
 * chased for. This is how we see them.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { QUESTIONS, CATALOGUE } from '../core/takeover-questions.js';

const GUILD = process.argv.find(a => /^\d{17,20}$/.test(a)) ?? '814321716872347648';
const WANT_LINK = process.argv.includes('--link');

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

if (WANT_LINK) {
  const [[row]] = await db.execute(
    'SELECT token FROM takeover_questionnaire_links WHERE guild_id = ? AND revoked = 0 LIMIT 1', [GUILD]);
  if (!row) {
    const { default: crypto } = await import('crypto');
    const token = crypto.randomBytes(32).toString('base64url');
    await db.execute(
      'INSERT INTO takeover_questionnaire_links (token, guild_id, label) VALUES (?, ?, ?)',
      [token, GUILD, 'owner']);
    console.log(`\nminted: https://certifriedmultitool.com/kabster/${token}\n`);
  } else {
    console.log(`\nhttps://certifriedmultitool.com/kabster/${row.token}\n`);
  }
  await db.end();
  process.exit(0);
}

const [rows] = await db.execute(
  'SELECT item_key, value, note, updated_at FROM takeover_questionnaire WHERE guild_id = ?', [GUILD]);
await db.end();

const byKey = new Map(rows.map(r => [r.item_key, r]));

// Count the two lists SEPARATELY. Counting every row in the table against QUESTIONS.length swept the
// 45 catalogue answers in with the 16 questions and cheerfully reported "61 of 16 answered".
const has = (k) => { const r = byKey.get(k); return !!(r && (r.value || r.note?.trim())); };
const answeredQ = QUESTIONS.filter(q => has(q.key)).length;
const answeredC = CATALOGUE.filter(c => byKey.get(c.key)?.value).length;

console.log(`\n  ${answeredQ} of ${QUESTIONS.length} questions · ${answeredC} of ${CATALOGUE.length} features`
  + `${answeredQ === QUESTIONS.length && answeredC === CATALOGUE.length ? '  — answered in full' : ''}\n`);

let section = null;
for (const q of QUESTIONS) {
  if (q.section !== section) { section = q.section; console.log(`\n── ${section} ${'─'.repeat(Math.max(0, 58 - section.length))}`); }

  const a = byKey.get(q.key);
  if (!a || (!a.value && !a.note?.trim())) {
    console.log(`\n  ○ ${q.q}\n      (not answered)`);
    continue;
  }

  const chosen = q.options.find(o => o.v === a.value);
  console.log(`\n  ● ${q.q}`);
  if (chosen) console.log(`      → ${chosen.label}${chosen.detail ? `  (${chosen.detail})` : ''}`);
  else if (a.value) console.log(`      → ${a.value}`);
  if (a.note?.trim()) {
    console.log('      "' + a.note.trim().split('\n').join('\n       ') + '"');
  }
  console.log(`      ${new Date(a.updated_at).toISOString().slice(0, 16).replace('T', ' ')}`);
}

// ── The feature menu. Only what she touched: 44 untouched rows would bury the few she picked.
const picked = CATALOGUE.filter(c => byKey.get(c.key)?.value);
console.log(`\n\n── Features ${'─'.repeat(50)}`);

if (!picked.length) {
  console.log('\n  she has not been through the menu yet\n');
} else {
  const bucket = (v) => picked.filter(c => byKey.get(c.key).value === v);
  // "Tell me more" first — it is the only pick that is a job for us right now.
  const show = (v, lead) => {
    const rows = bucket(v);
    if (!rows.length) return;
    console.log(`\n  ${lead} (${rows.length})`);
    for (const c of rows) {
      console.log(`      ${c.name}`);
      const note = byKey.get(c.key)?.note?.trim();
      if (note) console.log(`        "${note.split('\n').join('\n         ')}"`);
    }
  };
  show('explain', 'WANTS THESE EXPLAINED — over to us');
  show('yes', 'Wants these');
  show('no', 'Does not want these');
  console.log('');
}
process.exit(0);
