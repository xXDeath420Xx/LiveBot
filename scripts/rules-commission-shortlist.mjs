/*
 * Final shortlist: which bot-authored rules documents actually need anti-commission wording.
 *
 *   node scripts/rules-commission-shortlist.mjs [rules-classified.json]
 *
 * Offline — reads the cached full text from the classify pass, no Discord calls.
 *
 * Replaces the earlier numbered-rule heuristic, which silently discarded any rules document written
 * with bullets or emoji instead of "1. 2. 3." Classification is now based on how many DIRECTIVE
 * statements a message contains (prohibitions and obligations), which is what actually makes a
 * message a rules document regardless of how it is formatted.
 *
 * Per-member welcome greetings are excluded separately: they are short, they @-mention the joiner,
 * and a channel full of near-identical ones is a join feed, not a rulebook.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const IN = process.argv[2] || 'rules-classified.json';
const data = JSON.parse(readFileSync(IN, 'utf8'));
const all = [...(data.real || []), ...(data.noise || [])];

// Explicitly excluded by the owner — do not touch these servers.
const EXCLUDE_GUILDS = new Set([
  '961514092848382043',   // YYZ Studio
  '1475096615940521994',  // Hummus Nation
  '1142257437555032097',  // The Grr Den | GirlGoGrr
  '934967938186899456',   // The Emeralds
]);

// Directive language — the actual substance of a rule, independent of formatting.
const DIRECTIVE = [
  /\bno\s+(?:spam|nsfw|drama|hate|racism|harassment|bullying|advertis|self.?promo|begging|politics|toxicity|slurs|links|bots?)\b/gi,
  /\b(?:do not|don'?t|never)\b/gi,
  /\b(?:must|should|required to|need to|please)\b/gi,
  /\b(?:not allowed|prohibited|forbidden|banned|zero tolerance|will result in|results in)\b/gi,
  /\b(?:keep it|be respectful|respect|follow)\b/gi,
];

const COMMISSION = /commission|paid work|for hire|freelance|rate sheet|price sheet|marketplace|selling (?:art|services)/i;
const AD_POLICY = /self.?promo|self.?promotion|advertis|soliciting|solicitation|no promo\b|promote your/i;

function directiveCount(text) {
  const hits = new Set();
  for (const re of DIRECTIVE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) hits.add(m[0].toLowerCase());
  }
  return hits.size;
}

/** A per-member join greeting, not a rulebook. */
function isGreeting(f) {
  const t = f.text || '';
  const mentionsAJoiner = /<@!?\d+>/.test(t);
  return (mentionsAJoiner && f.chars < 700) || (f.chars < 300 && /welcome/i.test(t));
}

const scored = all.map((f) => ({
  ...f,
  directives: directiveCount(f.text || ''),
  greeting: isGreeting(f),
  hasCommission: COMMISSION.test(f.text || ''),
  hasAdPolicy: AD_POLICY.test(f.text || ''),
}));

const excluded = scored.filter((f) => EXCLUDE_GUILDS.has(f.guildId));
const eligible = scored.filter((f) => !EXCLUDE_GUILDS.has(f.guildId));

const rulesDocs = eligible.filter((f) => !f.greeting && f.chars >= 300 && f.directives >= 3);
const dropped = eligible.filter((f) => !rulesDocs.includes(f));

// One doc per guild+channel — a channel with repeats keeps the longest (the real rulebook).
const best = new Map();
for (const f of rulesDocs) {
  const k = `${f.guildId}:${f.channelId}`;
  if (!best.has(k) || f.chars > best.get(k).chars) best.set(k, f);
}
const finalDocs = [...best.values()].sort((a, b) => a.guildName.localeCompare(b.guildName));

const needsWork = finalDocs.filter((f) => !f.hasCommission);
const covered = finalDocs.filter((f) => f.hasCommission);
const tighten = needsWork.filter((f) => f.hasAdPolicy);
const addNew = needsWork.filter((f) => !f.hasAdPolicy);

const line = '─'.repeat(80);
console.log(`\n${line}\nSHORTLIST — bot-authored rules docs needing anti-commission wording\n${line}`);
console.log(`\ncandidates re-scored : ${all.length}`);
console.log(`excluded by request  : ${excluded.length} messages across ${new Set(excluded.map((f) => f.guildName)).size} servers`);
console.log(`greetings / stubs    : ${dropped.length} dropped`);
console.log(`real rules documents : ${finalDocs.length}   (already covered: ${covered.length})`);

console.log(`\n${line}\nA. TIGHTEN an existing vague self-promo rule — ${tighten.length}\n${line}`);
for (const f of tighten) {
  console.log(`  ${f.guildName.padEnd(30)} #${f.channelName.padEnd(26)} ${String(f.chars).padStart(5)} chars  ${f.directives} directives`);
  console.log(`      guild ${f.guildId}  msg ${f.messageId}`);
}

console.log(`\n${line}\nB. NO advertising rule at all — add one — ${addNew.length}\n${line}`);
for (const f of addNew) {
  console.log(`  ${f.guildName.padEnd(30)} #${f.channelName.padEnd(26)} ${String(f.chars).padStart(5)} chars  ${f.directives} directives`);
  console.log(`      guild ${f.guildId}  msg ${f.messageId}`);
}

if (covered.length) console.log(`\n✓ already covered: ${covered.map((f) => f.guildName).join(', ')}`);
console.log(`\nexcluded servers (untouched): ${[...new Set(excluded.map((f) => f.guildName))].join(', ')}`);

writeFileSync('rules-shortlist.json', JSON.stringify({ tighten, addNew, covered, excludedGuilds: [...EXCLUDE_GUILDS] }, null, 2));
console.log('\nshortlist → rules-shortlist.json');
