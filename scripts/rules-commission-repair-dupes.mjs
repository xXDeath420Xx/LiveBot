/*
 * Repair the four rulebooks that got their commission block applied twice.
 *
 *   node scripts/rules-commission-repair-dupes.mjs           # dry run
 *   node scripts/rules-commission-repair-dupes.mjs --apply
 *
 * Cause: for these four the replacement text CONTAINS the original anchor (mode 'replace' where the
 * new text keeps the old sentence, and mode 'append' which leaves the anchor in place). On a second
 * run the anchor still matched exactly once, so the block was inserted again.
 *
 * Fix here is narrow and safe: collapse an EXACT adjacent duplicate (X+X → X) of the known added
 * block, and only when it appears exactly twice. Anything else is left alone.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import encryption from '../utils/encryption.js';

const APPLY = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The exact block each spec added, copied verbatim from rules-commission-apply.mjs.
const DUPES = [
  { msg: '1483987036406022177', who: 'The Devils Den',
    block: ' This includes commission sales of any kind — art, emotes, VTuber models, rigging, overlays, stream packages — along with price lists and "DM for pricing" posts. Do not DM members with offers; an unsolicited commission DM is treated exactly the same as posting it publicly.' },

  { msg: '1473666862813548636', who: 'CruciCafe Fam',
    block: '\n\n7. NO SELLING OR COMMISSIONS:\n\n• This server is not a marketplace. Do not advertise or sell paid work here — this includes commissions of any kind (art, emotes, VTuber models, rigging, overlays, logos, stream packages), price lists, and "DM me for pricing" posts. Do not DM members with offers; an unsolicited commission DM is treated exactly the same as posting it publicly.\n\nFailing to follow this rule will lead to removal, and accounts that join only to advertise will be banned without warning.' },

  { msg: '1505569273571971135', who: 'ｅｒｉｎｓｏｐｈｉａａ',
    block: '\n\n7 | No Selling or Commissions\nThis isn\'t a marketplace — no commissions (art, emotes, VTuber models, overlays), no price lists, and no "DM me for pricing". Please don\'t DM anyone here with offers either.' },

  { msg: '1490710597782864034', who: 'K A T E O O O _',
    block: '# No selling or commissions.\r\nNot a marketplace. No commission ads (art, emotes, VTuber models, overlays), no price lists, no “DM me for pricing” — and don’t DM people here with offers.\r\n' },
];

const shortlist = JSON.parse(readFileSync('rules-shortlist.json', 'utf8'));
const meta = new Map([...shortlist.tighten, ...shortlist.addNew].map((f) => [f.messageId, f]));

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

async function tokenFor(guildId) {
  const [[b]] = await db.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1)',
    [guildId]).catch(() => [[]]);
  if (b?.bot_token) { try { return encryption.decrypt(JSON.parse(b.bot_token)); } catch { /* fall through */ } }
  return process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || null;
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

let fixed = 0, clean = 0, failed = 0;

for (const d of DUPES) {
  const m = meta.get(d.msg);
  const token = await tokenFor(m.guildId);
  const cur = await api(`/channels/${m.channelId}/messages/${d.msg}`, token);
  if (!cur.ok) { console.log(`✗ ${d.who}: fetch ${cur.status}`); failed++; continue; }

  const embeds = cur.body.embeds.map((e) => ({ ...e }));
  let touched = false;

  for (const e of embeds) {
    if (!e.description) continue;
    const occurrences = e.description.split(d.block).length - 1;
    if (occurrences === 0) continue;
    if (occurrences !== 2) {
      console.log(`!  ${d.who}: block appears ${occurrences}× (expected 2) — leaving alone`);
      continue;
    }
    if (!e.description.includes(d.block + d.block)) {
      console.log(`!  ${d.who}: the two copies are not adjacent — leaving alone`);
      continue;
    }
    e.description = e.description.replace(d.block + d.block, d.block);
    touched = true;
  }

  if (!touched) { console.log(`= ${d.who}: nothing to collapse`); clean++; continue; }

  console.log(`▸ ${d.who}: collapsing duplicate (${d.block.length} chars)`);
  if (APPLY) {
    const res = await api(`/channels/${m.channelId}/messages/${d.msg}`, token, { method: 'PATCH', body: JSON.stringify({ embeds }) });
    if (res.ok) { console.log('  ✅ repaired'); fixed++; }
    else { console.log(`  ❌ PATCH ${res.status}`); failed++; }
    await sleep(500);
  } else { fixed++; }
}

console.log(`\n${APPLY ? 'repaired' : 'would repair'} ${fixed} · already clean ${clean} · failed ${failed}`);
if (!APPLY) console.log('DRY RUN — nothing changed.');
await db.end();
