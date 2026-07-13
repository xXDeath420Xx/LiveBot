/*
 * Recover cowoncy balances from the real OwO bot's own replies.
 *
 *   node scripts/owo-import-cowoncy.mjs <guildId> [channelId]           # dry run
 *   node scripts/owo-import-cowoncy.mjs <guildId> [channelId] --apply
 *
 * Cowoncy was the ONE piece of OwO progress we said could not be carried over: unlike level, XP,
 * gems, crates and the pet team — all of which OwO prints somewhere — a balance only ever appears if
 * somebody actually runs `owo balance`. Nobody had, so there was nothing to read.
 *
 * Now they have, so there is. This reads it.
 *
 * ATTRIBUTION IS THE WHOLE PROBLEM. OwO's reply names the user by their **OwO display name**
 * ("Kabs"), not their Discord username ("karabi"), so the reply alone cannot tell you whose balance
 * it is. We therefore never match on that name. Instead we pair each `owo balance` TRIGGER with the
 * OwO reply that follows it, and attribute the balance to the person who asked — the one thing we
 * can be certain of. A trigger that checks someone ELSE (`owo balance @them`) is attributed to the
 * mentioned user, not the asker, because that is whose balance OwO printed.
 *
 * REST-GET only against Discord; writes only to our own owo_cowoncy table. Safe while PM2 runs.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';

const GUILD = process.argv[2];
const CHANNEL = process.argv.find((a, i) => i > 2 && /^\d{17,20}$/.test(a)) ?? null;
const APPLY = process.argv.includes('--apply');

if (!GUILD || !/^\d{17,20}$/.test(GUILD)) {
  console.error('usage: node scripts/owo-import-cowoncy.mjs <guildId> [channelId] [--apply]');
  process.exit(1);
}

const OWO_BOT = '408785106942164992';
/** `owo balance`, `owo cash`, `owo bal`, `owo money` — with or without a prefix, with a target. */
const TRIGGER = /^(?:owo\s*|[!?$.]\s*)?(?:balance|bal|cash|money)\b/i;
/** OwO's reply: "<:cowoncy:...> **| Kabs**, you currently have **__1,671,101__ cowoncy!**" */
const REPLY = /you currently have\s*\*{0,2}_{0,2}([\d,]+)_{0,2}\*{0,2}\s*cowoncy/i;
/** A reply more than this long after the trigger is a different conversation, not an answer to it. */
const WINDOW_MS = 20_000;

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

const [[map]] = await db.execute('SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?', [GUILD]);
const [[bot]] = await db.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [map?.bot_id ?? '']);
if (!bot) { console.error(`no custom bot mapped to guild ${GUILD}`); process.exit(1); }
const token = encryption.decrypt(JSON.parse(bot.bot_token));

const api = async (path) => {
  for (;;) {
    const res = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await new Promise(s => setTimeout(s, (j.retry_after ?? 1) * 1000 + 250));
      continue;
    }
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  }
};

const channels = CHANNEL
  ? [{ id: CHANNEL, name: '(given)' }]
  : (await api(`/guilds/${GUILD}/channels`)).filter(c => [0, 5].includes(c.type));

/** userId -> { money, when, channel, via } — the LATEST balance wins, since it is the current one. */
const found = new Map();

for (const ch of channels) {
  let before = '';
  const msgs = [];
  for (;;) {
    const page = await api(`/channels/${ch.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
    if (!page?.length) break;
    msgs.push(...page);
    if (page.length < 100 || msgs.length >= 1000) break;
    before = page[page.length - 1].id;
  }
  // Discord returns newest-first; walk oldest-first so "the reply follows the trigger" holds.
  const ordered = msgs.reverse();

  for (let i = 0; i < ordered.length; i++) {
    const trig = ordered[i];
    if (trig.author?.bot) continue;
    if (!TRIGGER.test((trig.content ?? '').trim())) continue;

    // The first OwO cowoncy reply after this trigger, within the window.
    const reply = ordered.slice(i + 1, i + 6).find(m =>
      m.author?.id === OWO_BOT
      && REPLY.test(m.content ?? '')
      && Date.parse(m.timestamp) - Date.parse(trig.timestamp) < WINDOW_MS);
    if (!reply) continue;

    const money = Number(REPLY.exec(reply.content)[1].replace(/,/g, ''));
    if (!Number.isFinite(money)) continue;

    // `owo balance @someone` prints THEIR balance, not the asker's. Attribute it to them.
    const target = (trig.content.match(/<@!?(\d+)>/) ?? [])[1] ?? trig.author.id;

    const prev = found.get(target);
    if (!prev || Date.parse(reply.timestamp) > Date.parse(prev.when)) {
      found.set(target, {
        money,
        when: reply.timestamp,
        channel: ch.name,
        via: target === trig.author.id ? 'own' : `checked by @${trig.author.username}`,
        asker: trig.author.username,
      });
    }
  }
}

console.log(`\n${APPLY ? 'IMPORTING' : 'DRY RUN — nothing will be written'}\n`);

if (!found.size) {
  console.log('No cowoncy balances found. Somebody has to run `owo balance` in a channel we can read,');
  console.log('while the real OwO bot is still in the server. There is no other way to learn it.\n');
  await db.end();
  process.exit(0);
}

console.log('user id'.padEnd(21) + 'cowoncy'.padStart(12) + '   read from');
console.log('─'.repeat(72));

for (const [userId, f] of [...found].sort((a, b) => b[1].money - a[1].money)) {
  const [[cur]] = await db.execute(
    'SELECT money FROM owo_cowoncy WHERE guild_id = ? AND id = ?', [GUILD, userId]);
  const now = Number(cur?.money ?? 0);

  console.log(`${userId.padEnd(21)}${f.money.toLocaleString().padStart(12)}   ${f.when.slice(0, 16)} #${f.channel}`
    + (f.via === 'own' ? '' : `  (${f.via})`));
  console.log(`${''.padEnd(21)}${('was ' + now.toLocaleString()).padStart(12)}   ${now === f.money ? '— already correct' : '→ will be set'}`);

  if (APPLY && now !== f.money) {
    // Set, not add. This is a RECOVERED TRUTH from the incumbent, not a reward — adding would
    // double anyone who has already earned some with us.
    await db.execute(
      `INSERT INTO owo_cowoncy (guild_id, id, money, daily_streak) VALUES (?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE money = VALUES(money)`,
      [GUILD, userId, f.money]);
  }
}

console.log('');
if (!APPLY) console.log('Re-run with --apply to import these.\n');
else console.log(`Imported ${found.size} balance(s).\n`);

await db.end();
process.exit(0);
