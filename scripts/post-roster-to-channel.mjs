import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';

const { resolveBotForGuild } = await import('/home/death/CertiFriedUtility/utils/bot-resolver.js');

//   node scripts/post-roster-to-channel.mjs <census.json> --link <artifactUrl> [--dry]
//
// The census path and artifact link are arguments: the previous run baked in a scratchpad
// path and an artifact id from the session that made them, neither of which exists on the
// next audit.
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);

const CHANNEL = arg('--channel', '1469932427647516856');
// The acting bot comes from guild_bot_mapping — never pinned here.
const GUILD = arg('--guild', '1469931133981687873'); // Forsaken Warriors — the guild that owns CHANNEL
const LINK = arg('--link', null);
const DRY = process.argv.includes('--dry');
// Comma-separated message ids to update in place. Editing rather than reposting keeps the
// audit at its original position in the channel and keeps any links to it working.
const EDIT = (arg('--edit', '') || '').split(',').map(x => x.trim()).filter(Boolean);
const PREV = arg('--prev', null);   // previous audit json — adds a movement embed
const VOICE = arg('--voice', null); // voice audit json — adds voice figures
const CENSUS = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;

if (!CENSUS) { console.error('usage: post-roster-to-channel.mjs <census.json> --link <url> [--dry]'); process.exit(1); }

const r = JSON.parse(readFileSync(CENSUS));
const posters = r.posters;
const core = posters.filter(p => p.messages > 5);
const occ = posters.filter(p => p.messages <= 5);
const n = (x) => x.toLocaleString('en-US');

// Discord renders *_~|` and ] as markdown — neutralise them so display names stay literal
const md = (s) => String(s).replace(/([*_~`|\\<>[\]])/g, '\\$1');

const pad = (s, w) => String(s).padStart(w, ' ');

const coreLines = core.map((p, i) =>
  `\`${pad('#' + (i + 1), 3)} ${pad(n(p.messages), 5)}\` **${md(p.displayName)}**`);
const occLines = occ.map((p, i) =>
  `\`${pad('#' + (core.length + i + 1), 3)} ${pad(n(p.messages), 5)}\` ${md(p.displayName)}`);

const chunk = (lines, limit = 3900) => {
  const out = []; let buf = '';
  for (const l of lines) {
    if (buf.length + l.length + 1 > limit) { out.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + l;
  }
  if (buf) out.push(buf);
  return out;
};

const TEAL = 0x4FB6B4, MUTED = 0x5A6A6E, INK = 0x136E76;

// Median is computed, not asserted — the previous post hardcoded "4".
const counts = posters.map(p => p.messages).sort((a, b) => a - b);
const median = counts.length % 2
  ? counts[(counts.length - 1) / 2]
  : Math.round((counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2);

const deniedCount = r.scanned.denied ?? 0;

const voiceReport = VOICE ? JSON.parse(readFileSync(VOICE)) : null;
const voiceById = new Map((voiceReport?.voice ?? []).map(v => [v.id, v]));
const voiceByName = new Map((voiceReport?.voice ?? [])
  .map(v => [String(v.displayName ?? '').normalize('NFKC').toLowerCase().trim(), v]));
const voiceOnly = (voiceReport?.voice ?? [])
  .filter(v => !posters.some(p => p.id === v.id))
  .sort((a, b) => b.seconds - a.seconds);
const durOf = (secs) => secs >= 36000 ? `${Math.round(secs / 3600)}h`
  : secs >= 3600 ? `${(secs / 3600).toFixed(1).replace(/\.0$/, '')}h`
  : secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;

const summary = {
  color: INK,
  title: '90-Day Poster Roster',
  ...(LINK ? { url: LINK } : {}),
  description:
    `Every member who posted in **the Forsaken Warriors** between ` +
    `**${r.window.from.slice(0, 10)}** and **${r.window.to.slice(0, 10)}**.\n\n` +
    (deniedCount === 0
      ? `Complete census — all **${r.scanned.containers}** messageable channels and threads were read to the cutoff, ` +
        `**zero** were unreadable. Bot and webhook posts are excluded.`
      : `Read **${r.scanned.readable}** of **${r.scanned.containers}** messageable channels and threads to the cutoff; ` +
        `**${deniedCount}** could not be read by the bot and are not counted. Bot and webhook posts are excluded.`),
  fields: [
    { name: 'Unique posters', value: `**${posters.length}**`, inline: true },
    { name: 'Posted > 5 times', value: `**${core.length}**`, inline: true },
    { name: 'Posted ≤ 5 times', value: `**${occ.length}**`, inline: true },
    { name: 'Member messages', value: n(r.totals.humanMessages), inline: true },
    { name: 'Median / member', value: String(median), inline: true },
    { name: 'Messages read', value: n(r.totals.messages), inline: true },
    ...(voiceReport ? [
      { name: 'Voice hours', value: `**${n(Math.round(voiceReport.totals.humanHours))}**`, inline: true },
      { name: 'Members in voice', value: `**${voiceReport.totals.humanVoiceUsers}**`, inline: true },
      { name: 'Voice sessions', value: n(voiceReport.totals.humanSessions), inline: true },
    ] : []),
  ],
  footer: { text: 'Read-only audit · counts are exact, not sampled' },
  timestamp: new Date().toISOString(),
};

const embeds = [summary];

// ── movement since the previous audit ────────────────────────────────────────
// Only built when a previous audit is supplied. The comparison is by DISPLAY NAME because
// that is all the 2 Aug post preserved, which makes a rename look like one departure plus
// one arrival. That is repairable: the previous audit was a complete census of its window,
// so anyone posting in that window was counted then — a current poster whose first post
// predates the previous cutoff but whose name is missing from that roster was counted under
// a different name, i.e. renamed, not new.
if (PREV) {
  const prev = JSON.parse(readFileSync(PREV));
  const prevEnd = Date.parse(prev.window.to + 'T23:59:59Z');
  const norm = (x) => String(x).normalize('NFKC').toLowerCase().trim();
  const prevMap = new Map(prev.roster.map(([nm, c]) => [norm(nm), { name: nm, count: c }]));
  const curNames = new Set(posters.map(p => norm(p.displayName)));

  const unmatched = posters.filter(p => !prevMap.has(norm(p.displayName)));
  const renamed = unmatched.filter(p => Date.parse(p.firstPost) <= prevEnd);
  const renamedOld = new Set(renamed.map(p => norm(p.displayName)));
  const arrived = unmatched.filter(p => Date.parse(p.firstPost) > prevEnd)
    .sort((a, b) => b.messages - a.messages);
  const quiet = [...prevMap.values()]
    .filter(p => !curNames.has(norm(p.name)))
    .sort((a, b) => b.count - a.count);

  // Increases only. A lower count than August usually means the 90-day window slid past
  // that member's early activity, not that they went quiet — so presenting drops as
  // decline would be misleading. A gain cannot be produced by the window moving.
  const risers = posters
    .filter(p => prevMap.has(norm(p.displayName)))
    .map(p => ({ name: p.displayName, now: p.messages, then: prevMap.get(norm(p.displayName)).count }))
    .filter(x => x.now > x.then)
    .sort((a, b) => (b.now - b.then) - (a.now - a.then))
    .slice(0, 5);

  const cap = (arr, n, fmt) => arr.slice(0, n).map(fmt).join(', ') +
    (arr.length > n ? ` +${arr.length - n} more` : '');

  const parts = [];
  // Absent from text does not mean absent from the server. Anyone in the voice log is
  // pulled out of the quiet list — flagging them as inactive is the one error in this
  // report that would actually cost the guild a member.
  const quietInVoice = quiet.filter(p => voiceByName.has(norm(p.name)));
  const quietEverywhere = quiet.filter(p => !voiceByName.has(norm(p.name)));
  const genuineQuiet = quietEverywhere.length - renamed.length;
  parts.push(`**${arrived.length} new** · **${genuineQuiet} gone quiet** — measured against the ` +
    `${prev.window.from} → ${prev.window.to} audit.`);
  // Two different accounts can share a display name (there are two "Thorslayer"s this
  // window). Append the handle only where the name alone is ambiguous.
  const nameCount = new Map();
  for (const p of arrived) nameCount.set(p.displayName, (nameCount.get(p.displayName) ?? 0) + 1);
  const label = (p) => nameCount.get(p.displayName) > 1
    ? `${md(p.displayName)} (@${md(p.username)}, ${p.messages})`
    : `${md(p.displayName)} (${p.messages})`;

  if (arrived.length) parts.push(`\n**Joined since ${prev.window.to}**\n` + cap(arrived, 24, label));
  // Listed in full. Which of these is a departure and which is a renamed member's old
  // name cannot be told apart from display names alone, so the header says how many are
  // old names rather than implying every one of them left.
  if (quietInVoice.length) parts.push(
    `\n**Not typing, but still here** — ${quietInVoice.length} of the names missing from the text roster ` +
    `are active in voice\n` +
    quietInVoice.map(p => {
      const v = voiceByName.get(norm(p.name));
      return `${md(p.name)} (${durOf(v.seconds)} voice, last ${v.lastSeen.slice(0, 10)})`;
    }).join(', '));

  if (quietEverywhere.length) parts.push(
    `\n**No messages and no voice this window** — ${quietEverywhere.length} name${quietEverywhere.length === 1 ? '' : 's'} ` +
    `from the 2 Aug roster${renamed.length ? `, ${renamed.length} of which ${renamed.length === 1 ? 'is' : 'are'} an old display name above` : ''}\n` +
    cap(quietEverywhere, 20, p => `${md(p.name)} (${p.count} then)`));
  if (risers.length) parts.push(`\n**Biggest increases**\n` +
    risers.map(x => `${md(x.name)} ${x.then} → **${x.now}**`).join(', '));
  const notes = [];
  if (renamed.length) notes.push(`${renamed.length} apparent arrival${renamed.length === 1 ? '' : 's'} ` +
    `(${renamed.map(p => md(p.displayName)).join(', ')}) ` +
    `${renamed.length === 1 ? 'is a' : 'are'} display-name change${renamed.length === 1 ? '' : 's'}, not ${renamed.length === 1 ? 'a ' : ''}new member${renamed.length === 1 ? '' : 's'} — excluded above.`);
  notes.push('Counts lower than August usually mean the 90-day window slid past early-May activity, not a drop in posting; only increases are listed.');

  embeds.push({
    color: 0x9C5A22,
    title: '△ Movement since the 2 Aug audit',
    description: parts.join('\n').slice(0, 4000),
    footer: { text: notes.join(' · ').slice(0, 2040) },
  });
}
if (voiceReport) {
  // The full roster, not a top-N. A leaderboard answers "who is loudest"; an activity audit
  // has to answer "is this member still here", which needs every name — the same reason the
  // message roster lists all 103 posters rather than the top few.
  const V_CORE = 3600;                       // an hour, mirroring the >5-messages split
  const vCore = voiceReport.voice.filter(v => v.seconds >= V_CORE);
  const vOcc  = voiceReport.voice.filter(v => v.seconds <  V_CORE);

  const vLine = (v, i, bold) => {
    const nm = md(v.displayName ?? v.id);
    return `\`${pad('#' + (i + 1), 3)} ${pad(durOf(v.seconds), 5)}\` ` +
      `${bold ? `**${nm}**` : nm} \`${v.sessions}\``;
  };
  const vCoreLines = vCore.map((v, i) => vLine(v, i, true));
  const vOccLines  = vOcc.map((v, i) => vLine(v, i + vCore.length, false));

  embeds.push({
    color: 0x2E9AA0,
    title: '🔊 Voice activity — same 90 days',
    description:
      `**${n(Math.round(voiceReport.totals.humanHours))} hours** across ` +
      `**${n(voiceReport.totals.humanSessions)}** sessions from **${voiceReport.totals.humanVoiceUsers}** members.` +
      (voiceOnly.length
        ? `\n\n**In voice but never typed** — ${voiceOnly.length} members who do not appear in the message roster at all\n` +
          voiceOnly.map(v => `${md(v.displayName ?? v.id)} (${durOf(v.seconds)})`).join(', ')
        : ''),
    footer: { text: 'Trailing figure is session count. Durations from the bot\'s voice log, cross-checked against the mod-log voice embeds — no gaps. Bots excluded.' },
  });

  chunk(vCoreLines).forEach((d, i, a) => embeds.push({
    color: 0x2E9AA0,
    title: i === 0 ? `🔊 The ${vCore.length} in voice an hour or more` : '🔊 In voice (cont.)',
    description: d,
    ...(i === a.length - 1 ? { footer: { text: `${vCore.length} members · ${n(Math.round(vCore.reduce((x, v) => x + v.seconds, 0) / 3600))} hours` } } : {}),
  }));
  chunk(vOccLines).forEach((d, i, a) => embeds.push({
    color: MUTED,
    title: i === 0 ? `· The ${vOcc.length} in voice under an hour` : '· In voice, brief (cont.)',
    description: d,
    ...(i === a.length - 1 ? { footer: { text: `${vOcc.length} members · ${n(Math.round(vOcc.reduce((x, v) => x + v.seconds, 0) / 60))} minutes` } } : {}),
  }));
}

chunk(coreLines).forEach((d, i, a) => embeds.push({
  color: TEAL,
  title: i === 0 ? `⬥ The ${core.length} regulars — more than 5 messages` : `⬥ Regulars (cont.)`,
  description: d,
  ...(i === a.length - 1 ? { footer: { text: `${core.length} members · ${n(core.reduce((s, p) => s + p.messages, 0))} messages` } } : {}),
}));
chunk(occLines).forEach((d, i, a) => embeds.push({
  color: MUTED,
  title: i === 0 ? `· The ${occ.length} occasional — 5 messages or fewer` : `· Occasional (cont.)`,
  description: d,
  ...(i === a.length - 1 ? { footer: { text: `${occ.length} members · ${n(occ.reduce((s, p) => s + p.messages, 0))} messages` } } : {}),
}));

const size = (e) => JSON.stringify(e).length;
const chars = (e) => (e.title || '').length + (e.description || '').length +
  (e.footer?.text || '').length + (e.fields || []).reduce((s, f) => s + f.name.length + f.value.length, 0);

console.log('embeds:', embeds.length);
embeds.forEach((e, i) => console.log(`  [${i}] ${String(chars(e)).padStart(5)} chars  ${e.title}`));
const total = embeds.reduce((s, e) => s + chars(e), 0);
console.log('total embed chars:', total, total > 6000 ? '  ⚠ OVER 6000 — must split into 2 messages' : '  ✓ under 6000');
console.log('max single description:', Math.max(...embeds.map(e => (e.description || '').length)));

if (DRY) { console.log('\n--- dry run, nothing sent ---'); process.exit(0); }

// ── send ─────────────────────────────────────────────────────────────────────
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
let token;
try {
  const bot = await resolveBotForGuild(GUILD, { db });
  token = bot.token;
} finally { await db.end(); }

// group embeds into messages that stay under the 6000-char / 10-embed ceiling
const messages = []; let cur = [];
for (const e of embeds) {
  const would = cur.reduce((s, x) => s + chars(x), 0) + chars(e);
  if (cur.length && (would > 5500 || cur.length >= 10)) { messages.push(cur); cur = []; }
  cur.push(e);
}
if (cur.length) messages.push(cur);
console.log('\nsending as', messages.length, 'message(s)');

const call = async (method, path, body) => {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) { console.error(`FAILED ${method} ${path}:`, res.status, await res.text()); process.exit(1); }
  return res.status === 204 ? null : res.json();
};

for (let i = 0; i < messages.length; i++) {
  const body = { embeds: messages[i], allowed_mentions: { parse: [] } };
  if (EDIT[i]) {
    await call('PATCH', `/channels/${CHANNEL}/messages/${EDIT[i]}`, body);
    console.log(`  ✓ message ${i + 1}/${messages.length} edited — id ${EDIT[i]} (${messages[i].length} embeds)`);
  } else {
    const j = await call('POST', `/channels/${CHANNEL}/messages`, body);
    console.log(`  ✓ message ${i + 1}/${messages.length} sent — id ${j.id} (${messages[i].length} embeds)`);
  }
  if (i < messages.length - 1) await new Promise(s => setTimeout(s, 900));
}

// The roster shrinking would otherwise leave a stale trailing message behind, still showing
// the previous run's names as though they were current.
for (const stale of EDIT.slice(messages.length)) {
  await call('DELETE', `/channels/${CHANNEL}/messages/${stale}`);
  console.log(`  ✓ removed now-empty message ${stale}`);
}
console.log('done');
process.exit(0);
