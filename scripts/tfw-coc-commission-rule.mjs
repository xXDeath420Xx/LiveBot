/*
 * Add an explicit no-advertising / no-commission-sales rule to the Forsaken Warriors Code of Conduct.
 *
 *   node scripts/tfw-coc-commission-rule.mjs            # preview the rewritten embeds
 *   node scripts/tfw-coc-commission-rule.mjs --apply    # PATCH the live message
 *
 * EDITS the existing message in place rather than reposting it. That message carries the "I agree"
 * verify gate (verify_config.gate_message_id) and the role button, so a repost would orphan the gate
 * and lock every unverified member out. PATCHing only the `embeds` field leaves the components alone.
 *
 * REST-only, so it is safe to run while PM2 is up.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';

const GUILD = '1469931133981687873';
const CHANNEL = '1469931510088859730';
const MESSAGE = '1529067853108482112';
const APPLY = process.argv.includes('--apply');

// ── the new server rule ──────────────────────────────────────────────────────
// Appended as 18 rather than slotted next to rule 4, so the existing numbering keeps working —
// members and mods cite these by number.
const RULE_18 = `

**18 · No Advertising or Commission Sales**
tFW is not a marketplace. Do not advertise, sell, or solicit paid work here. This explicitly includes **commissions of any kind** — art, emotes, avatars, VTuber models, rigging, overlays, logos, banners, stream packages and edits — as well as design or development services, server boosting, account sales, and paid promotion.

In practice that means none of the following, anywhere in this server: "commissions open" or "commissions done" posts, price lists or rate sheets, "DM me for pricing/details", portfolio or sample drops that lead to a sale, or messaging members with offers. **An unsolicited commission DM to a member is treated exactly the same as posting it publicly.**

Promoting your own channel, socials or server also needs permission first — ask a Lead and we will help promote you instead. Matching posts are removed automatically, and drive-by accounts that join to advertise are banned without warning.`;

// The Twitch rule is the one people were pointing at as "the self-promo rule". It only ever covered
// Twitch chat and never named paid work, so it gets the same explicitness.
const TWITCH_OLD = `**3.** No self-promotion — do not advertise your own channel or socials. Ask, and we'll help promote you instead.`;
const TWITCH_NEW = `**3.** No self-promotion or soliciting — do not advertise your own channel, socials, or paid services (**commissions included**), and do not DM viewers with offers. Ask, and we'll help promote you instead.`;

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[bot]] = await db.execute(
  'SELECT bot_id, bot_token FROM custom_bots WHERE bot_id = (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1)',
  [GUILD]);
await db.end();
const token = encryption.decrypt(JSON.parse(bot.bot_token));

const api = async (path, init = {}) => {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
};

const cur = await api(`/channels/${CHANNEL}/messages/${MESSAGE}`);
if (!cur.ok) { console.error('could not fetch message', cur.status, cur.body); process.exit(1); }

const embeds = cur.body.embeds.map((e) => ({ ...e }));
if (embeds.length < 2) { console.error('unexpected embed layout'); process.exit(1); }

// Guard against a double-run — the rule text is idempotent, not additive.
if (embeds[0].description.includes('18 · No Advertising')) {
  console.log('Rule 18 is already present. Nothing to do.');
  process.exit(0);
}
if (!embeds[0].description.includes('**17 · Ranking Up**')) {
  console.error('CoC embed does not end where expected — aborting rather than guessing.');
  process.exit(1);
}

embeds[0].description = embeds[0].description.trimEnd() + RULE_18;

if (embeds[1].description.includes(TWITCH_OLD)) {
  embeds[1].description = embeds[1].description.replace(TWITCH_OLD, TWITCH_NEW);
} else {
  console.warn('! Twitch rule 3 did not match verbatim — leaving that embed untouched.');
}

for (const [i, e] of embeds.entries()) {
  const len = (e.description || '').length;
  console.log(`embed[${i}] "${e.title}" description ${len}/4096 chars${len > 4096 ? '  ← OVER LIMIT' : ''}`);
  if (len > 4096) process.exit(1);
}

console.log('\n' + '='.repeat(72) + '\nNEW RULE 18:\n' + RULE_18.trim());
console.log('\n' + '='.repeat(72) + '\nTWITCH RULE 3:\n' + TWITCH_NEW);

if (!APPLY) {
  console.log('\nPREVIEW ONLY — nothing changed. Re-run with --apply to publish.');
  process.exit(0);
}

// Only `embeds` is sent, so the acknowledge button and the verify gate survive untouched.
const res = await api(`/channels/${CHANNEL}/messages/${MESSAGE}`, {
  method: 'PATCH', body: JSON.stringify({ embeds }),
});
console.log(res.ok ? '\n✅ Code of Conduct updated in place (message id unchanged, gate intact).'
                   : `\n❌ PATCH failed ${res.status}: ${JSON.stringify(res.body)}`);
process.exit(res.ok ? 0 : 1);
