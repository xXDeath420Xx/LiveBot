/*
 * Apply tone-matched anti-commission wording to 23 bot-authored rules documents.
 *
 *   node scripts/rules-commission-apply.mjs           # dry run — shows every before/after
 *   node scripts/rules-commission-apply.mjs --apply
 *   node scripts/rules-commission-apply.mjs --only <messageId>
 *
 * Each spec names an ANCHOR: the exact text already in the message. The anchor must appear EXACTLY
 * ONCE across the message content, every embed description and every embed field — if it appears
 * zero times or more than once we skip that server rather than guess, because a wrong replacement
 * silently rewrites someone's rules.
 *
 * Edits in place (PATCH), never repost: most of these messages carry the verify / I-Agree button,
 * and a repost would orphan the gate and lock members out.
 *
 * Excluded by owner instruction, never touched: YYZ Studio, Hummus Nation, The Grr Den, The Emeralds.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync, writeFileSync } from 'node:fs';
import encryption from '../utils/encryption.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sanity net: these guild ids must never appear in a spec.
const FORBIDDEN = new Set(['961514092848382043', '1475096615940521994', '1142257437555032097', '934967938186899456']);

/**
 * mode 'replace' → anchor is swapped for `text`
 * mode 'append'  → `text` is placed immediately after anchor
 * mode 'fields'  → structured ops on embed fields, for the rulebooks that store one rule per field.
 *                  A text anchor cannot work there: "8. Mod Discretion\nSituations not covered…"
 *                  spans a field.name → field.value boundary that exists in no single string.
 *                  ops: {op:'editValue', name, value}
 *                       {op:'insertBefore', name, newName, newValue}
 *                       {op:'append', newName, newValue}
 *                       {op:'rename', name, to}
 */
const SPECS = [
  // ── GROUP A · tighten an existing vague self-promo rule ────────────────────
  { msg: '1486208390140264448', who: 'Anoraks Army', mode: 'fields', ops: [
    { op: 'editValue', name: '6. No Unsolicited Advertising',
      value: 'No DM advertising or random server invites. This server is not a marketplace — no selling or advertising paid work, including commissions of any kind (art, emotes, VTuber models, overlays, logos, stream packages). No price lists, no "DM me for pricing", and no DMing members with offers.' },
  ] },

  { msg: '1475015344740630731', who: 'CertiFried™', mode: 'replace',
    anchor: "> Don't flood channels with repeated messages, links, or unsolicited self-promotion. Share your content in the appropriate channels.",
    text: "> Don't flood channels with repeated messages, links, or unsolicited self-promotion. Share your content in the appropriate channels.\n> This is not a marketplace — no commission sales of any kind (art, emotes, VTuber models, rigging, overlays, stream packages), no price lists, and no \"DM me for pricing\". An unsolicited commission DM to a member counts exactly the same as posting it publicly." },

  { msg: '1528198477404835862', who: 'Garuda Team', mode: 'replace',
    anchor: '**2.** No spam, self-promo, or NSFW outside gated channels.',
    text: '**2.** No spam, self-promo, or NSFW outside gated channels. No commission sales or paid-work solicitation anywhere on this base — art, emotes, VTuber models, overlays, stream packages — and no DMing members with offers.' },

  { msg: '1529394778968686653', who: 'GreazySquad', mode: 'replace',
    anchor: '**3.** No spam, no DM advertising, no unsolicited self-promo outside <#1529393378490585089>.',
    text: '**3.** No spam, no DM advertising, no unsolicited self-promo outside <#1529393378490585089>. And no selling shit in here — no commissions (art, emotes, VTuber models, overlays, stream packages), no price lists, no "DM me for pricing". Sliding into people\'s DMs with offers counts the same as posting it.' },

  { msg: '915872726563029002', who: 'Oasis', mode: 'replace',
    anchor: 'Any self-advertising in nonapproved channels will result in a warning and link deletion.',
    text: 'Any self-advertising in nonapproved channels will result in a warning and link deletion. This isn\'t a marketplace either - no commission sales or paid-work advertising anywhere (art, emotes, VTuber models, overlays, stream packages), no price sheets, no "DM me for pricing", and don\'t DM members with offers. Accounts that join just to advertise get banned, no warning.' },

  { msg: '1473258226178068543', who: 'Spoodercord', mode: 'fields', ops: [
    { op: 'editValue', name: '4. No Spam or Self-Promotion',
      value: 'Do not spam messages, links, or unsolicited self-promotion. Use the appropriate channels for sharing content. This server is not a marketplace: advertising or selling paid work is prohibited, including commissions of any kind (art, emotes, VTuber models, rigging, overlays, stream packages), price lists, and "DM me for pricing" posts. Unsolicited commission DMs to members are treated as public advertising.' },
  ] },

  { msg: '1522064787268177997', who: "TeddGaming1987's", mode: 'replace',
    anchor: "**3.** 🎥 Self-promo goes in <#1493704642281082930> only — don't drop stream links elsewhere.",
    text: "**3.** 🎥 Self-promo goes in <#1493704642281082930> only — don't drop stream links elsewhere. 💸 No commission sales anywhere — art, emotes, VTuber models, overlays, price lists, \"DM me for pricing\" — and don't DM members with offers." },

  { msg: '1503947897689870486', who: 'The Bat Cave', mode: 'replace',
    anchor: "**15.** GFX artists: Please respect people's wishes if they choose not to accept a DM you send to them. Harassment will get you banned.",
    text: "**15.** GFX artists: this discord is not a place to sell. No commission advertising anywhere — art, emotes, VTuber models, rigging, overlays, logos — no price lists, and no \"DM me for pricing\" posts. Do not DM members offers. If someone chooses not to accept a DM from you, respect that immediately. Harassment will get you banned." },

  { msg: '1483987036406022177', who: 'The Devils Den', mode: 'replace',
    anchor: '**5. No Advertisements**\nWe do not tolerate unsolicited advertisements — especially follow bots! Use #promote-socials for self-promotion.',
    text: '**5. No Advertisements**\nWe do not tolerate unsolicited advertisements — especially follow bots! Use #promote-socials for self-promotion. This includes commission sales of any kind — art, emotes, VTuber models, rigging, overlays, stream packages — along with price lists and "DM for pricing" posts. Do not DM members with offers; an unsolicited commission DM is treated exactly the same as posting it publicly.' },

  { msg: '1476141871217770518', who: 'Vognarfamily', mode: 'replace',
    anchor: 'Self-advertising in unapproved channels will result in a warning and link deletion.',
    text: 'Self-advertising in unapproved channels will result in a warning and link deletion. This is not a marketplace — no commission sales or paid-work advertising anywhere (art, emotes, VTuber models, rigging, overlays, stream packages), no price sheets, and no "DM me for pricing". Read together with rules 12 and 13: do not DM members with offers.' },

  { msg: '1496387924000899072', who: 'Welcome to The Pac!', mode: 'replace',
    anchor: '• Self-promo outside designated channels',
    text: '• Self-promo outside designated channels\n• Selling or advertising commissions — art, emotes, VTuber models, rigging, overlays, stream packages\n• Price lists, "DM me for pricing" posts, or DMing Pac members with offers' },

  // ── GROUP B · no advertising rule at all, add one ──────────────────────────
  { msg: '1473666862813548636', who: 'CruciCafe Fam', mode: 'append',
    anchor: "have them come meet us over here in the discord and get to know the crew and we'll return the love :)",
    text: '\n\n7. NO SELLING OR COMMISSIONS:\n\n• This server is not a marketplace. Do not advertise or sell paid work here — this includes commissions of any kind (art, emotes, VTuber models, rigging, overlays, logos, stream packages), price lists, and "DM me for pricing" posts. Do not DM members with offers; an unsolicited commission DM is treated exactly the same as posting it publicly.\n\nFailing to follow this rule will lead to removal, and accounts that join only to advertise will be banned without warning.' },

  { msg: '1505569273571971135', who: 'ｅｒｉｎｓｏｐｈｉａａ', mode: 'append',
    anchor: "6 | Don't Displace Promo\nPlease don't promo outside of the given channel!",
    text: '\n\n7 | No Selling or Commissions\nThis isn\'t a marketplace — no commissions (art, emotes, VTuber models, overlays), no price lists, and no "DM me for pricing". Please don\'t DM anyone here with offers either.' },

  { msg: '1502814742249603154', who: "Flickster's House", mode: 'fields', ops: [
    { op: 'insertBefore', name: '4. Staff Has Final Say', newName: '4. No Selling or Commissions',
      newValue: 'This isn\'t a marketplace. No commission ads — art, emotes, VTuber models, overlays, stream packages — no price lists, no "DM me for pricing", and don\'t DM members with offers.' },
    { op: 'rename', name: '4. Staff Has Final Say', to: '5. Staff Has Final Say' },
  ] },

  { msg: '1462816759336665138', who: 'Flying Sharks', mode: 'replace',
    anchor: '**Have fun!**',
    text: '**No outside advertising** - this server is for the game. Don\'t advertise or sell services here (art, emotes, overlays, design work, "commissions open" posts), don\'t post price lists, and don\'t DM members with offers.\n\n**Have fun!**' },

  // NB the numbering uses U+2024 ONE DOT LEADER (․), not a full stop, and mixes fullwidth parens.
  // Copied byte-for-byte from the live embed — an ASCII "8." matches nothing here.
  { msg: '1501000421827936306', who: "Gah's Bunny Burrow", mode: 'append',
    anchor: '8․ Gah is Queen -（That is me Gah The Rabbit)',
    text: '\n\n9․ No selling or commissions -（this is a burrow, not a bazaar. No art, emote or VTuber commission ads, no price lists, and no hopping into DMs with offers）' },

  { msg: '1473169122887078019', who: 'Insomniac Crew', mode: 'fields', ops: [
    { op: 'insertBefore', name: '8. Mod Discretion', newName: '8. No Selling or Commissions',
      newValue: 'This is not a marketplace. No advertising or selling paid work — commissions of any kind (art, emotes, VTuber models, rigging, overlays, stream packages), price lists, or "DM me for pricing" posts. Don\'t DM members with offers; the unwanted-DM part of rule 1 applies here too.' },
    { op: 'rename', name: '8. Mod Discretion', to: '9. Mod Discretion' },
  ] },

  // This embed's description uses CRLF line endings and curly apostrophes — matched verbatim.
  { msg: '1490710597782864034', who: 'K A T E O O O _', mode: 'replace',
    anchor: '# Use common sense.\r\nIf it feels like it might be a problem, it probably is.',
    text: '# No selling or commissions.\r\nNot a marketplace. No commission ads (art, emotes, VTuber models, overlays), no price lists, no “DM me for pricing” — and don’t DM people here with offers.\r\n# Use common sense.\r\nIf it feels like it might be a problem, it probably is.' },

  { msg: '1480564647475024055', who: "Manee's Minecraft Mondays", mode: 'fields', ops: [
    { op: 'insertBefore', name: '8. Admins Have Final Say', newName: '8. No Selling or Commissions',
      newValue: 'This isn\'t a marketplace. No commission ads — art, emotes, skins, VTuber models, overlays — no price lists, and no "DM me for pricing". Don\'t DM members with offers either.' },
    { op: 'rename', name: '8. Admins Have Final Say', to: '9. Admins Have Final Say' },
  ] },

  { msg: '1532364937375125755', who: "MiSS SH3LBY's server", mode: 'replace',
    anchor: '- Follow [Discord ToS](<https://discord.com/terms>). Staff has final say on edge cases.',
    text: '- No selling or commissions — no art/emote/VTuber commission ads, price lists, or "DM me for pricing", and don\'t DM members with offers.\n- Follow [Discord ToS](<https://discord.com/terms>). Staff has final say on edge cases.' },

  { msg: '1482180956663316573', who: 'The Stab Crazies', mode: 'append',
    anchor: '**20.** No false reports to Discord.',
    text: '\n**21.** No commission sales or paid-work solicitation, in channels or DMs.' },

  { msg: '1508617120332906526', who: 'WildWolf server', mode: 'append',
    anchor: '> • **There will be no second chances**',
    text: '\n\n## 💸  Rule 5 — No selling or commissions\nThis is a community space, **not a marketplace**. Please do not advertise or sell paid work here — that includes commissions of any kind (art, emotes, VTuber models, rigging, overlays, stream packages), price lists, and "DM me for pricing" posts.\n> **Please do not DM Pack members with offers** — an unsolicited commission DM is treated exactly the same as posting it publicly.' },

  { msg: '1506378128841376028', who: 'Wolves of shadows', mode: 'fields', ops: [
    { op: 'append', newName: '5. No selling or commissions',
      newValue: 'Not a marketplace. No commission ads (art, emotes, VTuber models, overlays), no price lists, no "DM me for pricing" — and don\'t DM members with offers.' },
  ] },
];

// ── plumbing ─────────────────────────────────────────────────────────────────
const shortlist = JSON.parse(readFileSync('rules-shortlist.json', 'utf8'));
const meta = new Map();
for (const f of [...shortlist.tighten, ...shortlist.addNew]) meta.set(f.messageId, f);

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

const tokenCache = new Map();
async function tokenFor(guildId) {
  if (tokenCache.has(guildId)) return tokenCache.get(guildId);
  let token = null;
  const [[bot]] = await db.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1)',
    [guildId]).catch(() => [[]]);
  if (bot?.bot_token) { try { token = encryption.decrypt(JSON.parse(bot.bot_token)); } catch { /* fall through */ } }
  if (!token) token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || null;
  tokenCache.set(guildId, token);
  return token;
}

async function api(path, token, init = {}) {
  for (;;) {
    const r = await fetch(`https://discord.com/api/v10${path}`, {
      ...init, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep((j.retry_after ?? 1) * 1000 + 250); continue; }
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  }
}

/** Count anchor occurrences everywhere a human would read text. */
function countAnchor(msg, anchor) {
  let n = 0;
  const tally = (s) => { if (!s) return; n += s.split(anchor).length - 1; };
  tally(msg.content);
  for (const e of msg.embeds || []) {
    tally(e.description); tally(e.title); tally(e.footer?.text);
    for (const f of e.fields || []) { tally(f.name); tally(f.value); }
  }
  return n;
}

/** Rewrite wherever the anchor lives. Returns {content, embeds} or null. */
function rewrite(msg, spec) {
  const sub = (s) => {
    if (!s || !s.includes(spec.anchor)) return s;
    return s.replace(spec.anchor, spec.mode === 'append' ? spec.anchor + spec.text : spec.text);
  };
  const embeds = (msg.embeds || []).map((e) => {
    const out = { ...e };
    out.description = sub(e.description);
    if (e.fields) out.fields = e.fields.map((f) => ({ ...f, value: sub(f.value) }));
    return out;
  });
  return { content: sub(msg.content), embeds };
}

/**
 * Apply structured field ops. Returns {embeds} or throws with a reason — throwing is deliberate,
 * a half-applied op set would leave a rulebook mid-renumber.
 */
function applyFieldOps(msg, spec) {
  const embeds = (msg.embeds || []).map((e) => ({ ...e, fields: e.fields ? e.fields.map((f) => ({ ...f })) : e.fields }));
  const target = embeds.find((e) => (e.fields || []).length);
  if (!target) throw new Error('no embed with fields');

  for (const op of spec.ops) {
    const idx = op.name ? target.fields.findIndex((f) => f.name === op.name) : -1;
    if (op.op !== 'append' && idx === -1) throw new Error(`field "${op.name}" not found`);

    if (op.op === 'editValue') target.fields[idx].value = op.value;
    else if (op.op === 'rename') target.fields[idx].name = op.to;
    else if (op.op === 'insertBefore') target.fields.splice(idx, 0, { name: op.newName, value: op.newValue, inline: false });
    else if (op.op === 'append') target.fields.push({ name: op.newName, value: op.newValue, inline: false });
    else throw new Error(`unknown op ${op.op}`);
  }

  if (target.fields.length > 25) throw new Error('embed would exceed 25 fields');
  for (const f of target.fields) {
    if ((f.name || '').length > 256) throw new Error(`field name too long: ${f.name.slice(0, 40)}`);
    if ((f.value || '').length > 1024) throw new Error(`field value too long: ${f.name}`);
  }
  return { content: msg.content, embeds };
}

/**
 * The exact text a spec ADDS, as opposed to the text it carries over from the anchor.
 *
 * This distinction is the whole bug: for several specs the replacement deliberately keeps the
 * original sentence, so `text` still contains `anchor`. Checking "is the anchor still there?" or
 * "does the message mention commissions?" both answer yes after a successful run, and the block
 * gets applied a second time. Only the ADDED portion is a reliable applied/not-applied marker.
 */
function addedPortion(spec) {
  if (spec.mode === 'append') return spec.text;
  const t = spec.text, a = spec.anchor;
  if (t.startsWith(a)) return t.slice(a.length);   // anchor kept at the front
  if (t.endsWith(a)) return t.slice(0, t.length - a.length); // anchor kept at the end
  return t;                                        // full rewrite
}

/** Has this spec already been applied? Keeps re-runs idempotent. */
function alreadyApplied(msg, spec) {
  const hay = (msg.content || '') + JSON.stringify(msg.embeds || []);
  if (spec.mode === 'fields') {
    return spec.ops.some((o) => {
      if (o.newName) return (msg.embeds || []).some((e) => (e.fields || []).some((f) => f.name === o.newName));
      if (o.op === 'editValue') return (msg.embeds || []).some((e) => (e.fields || []).some((f) => f.name === o.name && f.value === o.value));
      if (o.op === 'rename') return (msg.embeds || []).some((e) => (e.fields || []).some((f) => f.name === o.to));
      return false;
    });
  }
  // Compare against the raw strings as they appear in the message, not JSON-escaped.
  const added = addedPortion(spec);
  const raw = [msg.content || '', ...(msg.embeds || []).flatMap((e) => [e.description || '', ...(e.fields || []).map((f) => f.value || '')])];
  return raw.some((s) => s.includes(added));
}

const results = [];
let ok = 0, skipped = 0, failed = 0;

for (const spec of SPECS) {
  if (ONLY && spec.msg !== ONLY) continue;
  const m = meta.get(spec.msg);
  if (!m) { console.log(`?? no metadata for ${spec.who} (${spec.msg}) — skipped`); skipped++; continue; }
  if (FORBIDDEN.has(m.guildId)) { console.log(`!! ${spec.who} is on the exclusion list — refusing`); skipped++; continue; }

  const token = await tokenFor(m.guildId);
  const cur = await api(`/channels/${m.channelId}/messages/${spec.msg}`, token);
  if (!cur.ok) { console.log(`✗ ${spec.who}: fetch ${cur.status}`); failed++; continue; }

  if (alreadyApplied(cur.body, spec)) { console.log(`= ${spec.who}: already applied, skipping`); skipped++; continue; }

  let next;
  if (spec.mode === 'fields') {
    try { next = applyFieldOps(cur.body, spec); }
    catch (e) { console.log(`✗ ${spec.who}: ${e.message} — SKIPPED`); failed++; continue; }
  } else {
    const hits = countAnchor(cur.body, spec.anchor);
    if (hits !== 1) {
      console.log(`✗ ${spec.who}: anchor matched ${hits}× (need exactly 1) — SKIPPED, not guessing`);
      failed++; continue;
    }
    next = rewrite(cur.body, spec);
  }

  const tooLong = next.embeds.find((e) => (e.description || '').length > 4096);
  if (tooLong) { console.log(`✗ ${spec.who}: embed would exceed 4096 chars — skipped`); failed++; continue; }

  const preview = spec.mode === 'fields'
    ? spec.ops.map((o) => `${o.op} «${o.newName || o.to || o.name}» ${(o.newValue || o.value || '').slice(0, 150)}`).join('\n    ')
    : spec.text.trim().replace(/\n/g, '\n    ').slice(0, 300);
  console.log(`\n▸ ${spec.who}  [${spec.mode}]  ${m.guildName} #${m.channelName}`);
  console.log(`  + ${preview}`);

  if (APPLY) {
    const payload = next.content ? { content: next.content, embeds: next.embeds } : { embeds: next.embeds };
    const res = await api(`/channels/${m.channelId}/messages/${spec.msg}`, token, { method: 'PATCH', body: JSON.stringify(payload) });
    if (res.ok) { console.log('  ✅ applied'); ok++; }
    else { console.log(`  ❌ PATCH ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`); failed++; }
    await sleep(600);
  } else { ok++; }
  results.push({ ...spec, guildId: m.guildId, guildName: m.guildName, channelName: m.channelName });
}

console.log(`\n${'─'.repeat(72)}`);
console.log(APPLY ? `applied ${ok} · skipped ${skipped} · failed ${failed}` : `would apply ${ok} · skipped ${skipped} · failed ${failed}`);
if (!APPLY) console.log('\nDRY RUN — nothing changed. Re-run with --apply.');
writeFileSync('rules-apply-report.json', JSON.stringify({ apply: APPLY, ok, skipped, failed, results }, null, 2));
await db.end();
