/*
 * Second pass over rules-commission-audit.mjs output: separate real rules documents from the
 * auto-posted welcome greetings that mention the word "rules" and therefore matched the first cut.
 *
 *   node scripts/rules-commission-classify.mjs <audit.json>
 *
 * READ-ONLY. Re-fetches only the messages the audit already flagged as ours, counts how many
 * numbered rules each actually contains, and reports the ones worth editing.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync, writeFileSync } from 'node:fs';
import encryption from '../utils/encryption.js';

const IN = process.argv[2];
if (!IN) { console.error('usage: node scripts/rules-commission-classify.mjs <audit.json>'); process.exit(1); }
const audit = JSON.parse(readFileSync(IN, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

const tokenCache = new Map();
async function tokenFor(guildId) {
  if (tokenCache.has(guildId)) return tokenCache.get(guildId);
  let token = null;
  const [[bot]] = await db.execute(
    `SELECT bot_token FROM custom_bots WHERE bot_id = (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1)`,
    [guildId]).catch(() => [[]]);
  if (bot?.bot_token) { try { token = encryption.decrypt(JSON.parse(bot.bot_token)); } catch { /* fall through */ } }
  if (!token) token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || null;
  tokenCache.set(guildId, token);
  return token;
}

async function api(path, token) {
  for (;;) {
    const r = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep((j.retry_after ?? 1) * 1000 + 250); continue; }
    return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : null };
  }
}

const flat = (s) => String(s || '').normalize('NFKC');
function messageText(m) {
  const parts = [m.content || ''];
  for (const e of m.embeds || []) {
    parts.push(e.title || '', e.description || '', e.footer?.text || '');
    for (const f of e.fields || []) parts.push(f.name || '', f.value || '');
  }
  return flat(parts.filter(Boolean).join('\n'));
}

/** Count distinct leading rule numbers — "1.", "**2 ·**", "3)" — at a line/segment start. */
function countRules(text) {
  const nums = new Set();
  const re = /(?:^|\n)\s*(?:\*\*|__)?\s*(\d{1,2})\s*(?:[.)·:]|\s*·)/g;
  let m;
  while ((m = re.exec(text))) nums.add(Number(m[1]));
  // Also catch inline "**1.**" runs used in single-paragraph rule blocks.
  const re2 = /\*\*(\d{1,2})[.)·]?\*\*/g;
  while ((m = re2.exec(text))) nums.add(Number(m[1]));
  return nums.size;
}

const ours = (audit.findings || []).filter((f) => f.ours);
const out = [];

for (const f of ours) {
  const token = await tokenFor(f.guildId);
  if (!token) continue;
  const r = await api(`/channels/${f.channelId}/messages/${f.messageId}`, token);
  if (!r.ok) continue;
  const text = messageText(r.body);
  out.push({ ...f, ruleCount: countRules(text), text });
  await sleep(120);
}

const REAL = out.filter((f) => f.ruleCount >= 3 && f.chars >= 300);
const NOISE = out.filter((f) => !(f.ruleCount >= 3 && f.chars >= 300));

const needs = REAL.filter((f) => !f.hasCommission);
const done = REAL.filter((f) => f.hasCommission);

console.log(`\nRe-checked ${out.length} bot-authored messages we can edit.`);
console.log(`  real rules documents : ${REAL.length}`);
console.log(`  welcome/greeting noise discarded : ${NOISE.length}\n`);

console.log('─'.repeat(78));
console.log(`REAL RULES DOCS MISSING COMMISSION WORDING — ${needs.length}`);
console.log('─'.repeat(78));
const byPolicy = { tighten: needs.filter((f) => f.hasAdPolicy), add: needs.filter((f) => !f.hasAdPolicy) };
console.log(`\n  ${byPolicy.tighten.length} have a vague self-promo rule to TIGHTEN:`);
for (const f of byPolicy.tighten) console.log(`    · ${f.guildName.padEnd(28)} #${f.channelName.padEnd(26)} ${f.ruleCount} rules  msg ${f.messageId}`);
console.log(`\n  ${byPolicy.add.length} have NO advertising rule at all — needs one ADDED:`);
for (const f of byPolicy.add) console.log(`    · ${f.guildName.padEnd(28)} #${f.channelName.padEnd(26)} ${f.ruleCount} rules  msg ${f.messageId}`);

if (done.length) {
  console.log(`\n  ✓ already covered: ${done.map((f) => f.guildName).join(', ')}`);
}

console.log(`\n  discarded as not-a-rules-doc: ${[...new Set(NOISE.map((f) => `${f.guildName}#${f.channelName}`))].join(', ')}`);

writeFileSync('rules-classified.json', JSON.stringify({ real: REAL, noise: NOISE }, null, 2));
console.log('\nfull text of each → rules-classified.json');
await db.end();
