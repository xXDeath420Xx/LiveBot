/*
 * Teach our free-games system what a guild has ALREADY been told, by reading the incumbent bot's
 * own posts.
 *
 *   node scripts/seed-free-games-seen.mjs <guildId>            # dry run — prints, writes nothing
 *   node scripts/seed-free-games-seen.mjs <guildId> --apply
 *
 * Why this has to exist: when we take over a guild, the bot we are replacing has usually been
 * announcing free games there for months. Nothing in our schema knew that, so our first catch-up
 * post would announce games the server has already seen — the single most obvious way to look
 * broken on day one.
 *
 * Identity comes from the STORE URL in the incumbent's message, not the title. Our scraper stores
 * Epic's internal GUID while FreeStuff links the page slug; the two never match, and titles are
 * hopeless (™, edition suffixes, "Free to keep" chatter). Both sides always carry the store link.
 *
 * Reads every message in every readable channel, back to the beginning — not a sample. A sample
 * would under-count, and an under-count here means a duplicate post in someone else's server.
 *
 * REST GET only. Safe to run while PM2 is live.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';
import { gameKeysIn } from '../utils/free-games-key.js';
import { walkComponents } from '../core/guild-analyzer.js';

const GUILD = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!GUILD || !/^\d{17,20}$/.test(GUILD)) {
  console.error('usage: node scripts/seed-free-games-seen.mjs <guildId> [--apply]');
  process.exit(1);
}

/** Bots that announce free games. A webhook they post through carries their name, so match that too. */
const FREE_GAME_BOTS = new Set(['672822334641537041']); // FreeStuff
const FREE_GAME_NAMES = /freestuff|free ?stuff|game ?deals?|free ?games?/i;

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
    if (res.status === 403 || res.status === 404) return null; // channel we cannot read
    if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
    return res.json();
  }
};

const channels = (await api(`/guilds/${GUILD}/channels`)).filter(c => [0, 5, 15].includes(c.type));
console.log(`\nreading ${channels.length} channel(s) in guild ${GUILD}…\n`);

/** game_key -> { title, when, channel } — first sighting wins, purely for the printout. */
const seen = new Map();
let scanned = 0, fromIncumbent = 0, unreadable = 0;

for (const ch of channels) {
  let before = '';
  for (;;) {
    const msgs = await api(`/channels/${ch.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
    if (msgs === null) { unreadable++; break; }
    if (!msgs.length) break;
    scanned += msgs.length;

    for (const m of msgs) {
      const byBot = FREE_GAME_BOTS.has(m.author?.id) || FREE_GAME_NAMES.test(m.author?.username ?? '');
      if (!byBot) continue;
      fromIncumbent++;

      // Components V2: content and embeds are EMPTY and every word lives in `components`. Reading
      // only content+embeds here would have found almost nothing — most FreeStuff posts are CV2.
      const { text } = walkComponents(m.components ?? []);
      const blob = [
        m.content,
        ...(m.embeds ?? []).flatMap(e => [e.title, e.description, e.url, ...(e.fields ?? []).map(f => f.value)]),
        ...text,
      ].filter(Boolean).join('\n');

      for (const key of gameKeysIn(blob)) {
        if (!seen.has(key)) seen.set(key, { when: m.timestamp.slice(0, 10), channel: ch.name });
      }
    }
    if (msgs.length < 100) break;
    before = msgs[msgs.length - 1].id;
  }
}

const byStore = {};
for (const k of seen.keys()) { const s = k.split(':')[0]; byStore[s] = (byStore[s] ?? 0) + 1; }

console.log(`scanned ${scanned} message(s); ${fromIncumbent} were from a free-games bot`);
if (unreadable) console.log(`${unreadable} channel(s) could not be read (no access) — see the warning below`);
console.log(`\nfound ${seen.size} distinct game(s) this guild has ALREADY been shown:`);
for (const [store, n] of Object.entries(byStore)) console.log(`    ${store.padEnd(6)} ${n}`);

if (!APPLY) {
  console.log('\nsample:');
  for (const [k, v] of [...seen].slice(0, 10)) console.log(`    ${k.padEnd(42)} ${v.when}  #${v.channel}`);
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to record these as already-seen.`);
  if (unreadable) {
    console.log(`\n⚠️  ${unreadable} channel(s) were unreadable. Any free-game post in them is INVISIBLE to this`);
    console.log('    seed, and could therefore be announced a second time. Grant read access and re-run.');
  }
  process.exit(0);
}

let written = 0;
for (const [key, v] of seen) {
  const [r] = await db.execute(
    `INSERT INTO free_games_seen (guild_id, game_key, title, source) VALUES (?, ?, NULL, 'incumbent')
     ON DUPLICATE KEY UPDATE seen_at = seen_at`, [GUILD, key]);
  if (r.affectedRows === 1) written++;
}
console.log(`\nrecorded ${written} new (${seen.size - written} already known).`);
console.log('These will never be announced to this guild. Anything NOT in this list, that is still');
console.log('genuinely free, will be.');
await db.end();
process.exit(0);
