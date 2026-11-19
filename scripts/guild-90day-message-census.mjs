/*
 * 90-day message census — every channel, every thread, every message, no sampling.
 *
 *   node scripts/guild-90day-message-census.mjs <guildId> <botId> [--days 90] [--out file.json]
 *
 * Read-only: every call is a REST GET, so it is safe while PM2 holds the gateway session
 * (the competing-sessions rule is about gateway logins, not REST).
 *
 * Answers: how many UNIQUE members posted in the window, and how many times each of them posted.
 * Bots and webhooks are counted separately and excluded from the member figure.
 * Channels the bot cannot read are reported explicitly rather than silently dropped.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync, createWriteStream } from 'node:fs';
import encryption from '../utils/encryption.js';

const GUILD = process.argv[2];
const BOT = process.argv[3];
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const DAYS = Number(arg('--days', 90));
const OUT = arg('--out', `/tmp/census-${GUILD}.json`);
const JSONL = OUT.replace(/\.json$/, '.jsonl');

if (!GUILD || !BOT) {
  console.error('usage: node scripts/guild-90day-message-census.mjs <guildId> <botId> [--days 90] [--out file.json]');
  process.exit(1);
}

const DISCORD_EPOCH = 1420070400000n;
const CUTOFF_MS = Date.now() - DAYS * 86400000;
const CUTOFF_SNOWFLAKE = ((BigInt(Math.floor(CUTOFF_MS)) - DISCORD_EPOCH) << 22n).toString();
const snowflakeMs = (id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

// ── auth ─────────────────────────────────────────────────────────────────────
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
let token;
try {
  const [[row]] = await db.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT]);
  if (!row) throw new Error(`bot ${BOT} not found in custom_bots`);
  token = encryption.decrypt(JSON.parse(row.bot_token));
} finally {
  await db.end();
}

let calls = 0;
async function api(path) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
    } catch (e) {
      if (attempt > 5) throw e;
      await new Promise(s => setTimeout(s, 2000 * (attempt + 1)));
      continue;
    }
    calls++;
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await new Promise(s => setTimeout(s, (j.retry_after ?? 1) * 1000 + 250));
      continue;
    }
    if (r.status === 403 || r.status === 404) return { __denied: r.status };
    if (r.status >= 500) {
      if (attempt > 5) throw new Error(`${r.status} on ${path}`);
      await new Promise(s => setTimeout(s, 1500 * (attempt + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} on ${path}: ${await r.text()}`);
    // leave a little headroom under the per-route bucket
    const rem = Number(r.headers.get('x-ratelimit-remaining'));
    if (rem === 0) {
      await new Promise(s => setTimeout(s, Number(r.headers.get('x-ratelimit-reset-after') ?? 1) * 1000 + 100));
    }
    return r.json();
  }
}

const say = (s) => process.stdout.write(s + '\n');
const guild = await api(`/guilds/${GUILD}?with_counts=true`);
if (guild.__denied) { console.error(`bot ${BOT} cannot see guild ${GUILD} (${guild.__denied})`); process.exit(1); }
say(`# ${guild.name} (${GUILD}) — ${DAYS}d census, cutoff ${new Date(CUTOFF_MS).toISOString()}`);

// ── enumerate every readable container ───────────────────────────────────────
const CH = { GUILD_TEXT: 0, DM: 1, GUILD_VOICE: 2, GUILD_CATEGORY: 4, GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10, PUBLIC_THREAD: 11, PRIVATE_THREAD: 12, GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15, GUILD_MEDIA: 16 };
const MESSAGEABLE = new Set([CH.GUILD_TEXT, CH.GUILD_VOICE, CH.GUILD_ANNOUNCEMENT, CH.GUILD_STAGE_VOICE,
  CH.ANNOUNCEMENT_THREAD, CH.PUBLIC_THREAD, CH.PRIVATE_THREAD]);
const THREAD_PARENT = new Set([CH.GUILD_TEXT, CH.GUILD_ANNOUNCEMENT, CH.GUILD_FORUM, CH.GUILD_MEDIA]);

const channels = await api(`/guilds/${GUILD}/channels`);
const catName = new Map(channels.filter(c => c.type === CH.GUILD_CATEGORY).map(c => [c.id, c.name]));
const targets = new Map(); // id -> {id,name,type,parent}

for (const c of channels) {
  if (MESSAGEABLE.has(c.type)) {
    targets.set(c.id, { id: c.id, name: c.name, type: c.type, category: catName.get(c.parent_id) ?? null, kind: 'channel' });
  }
}

// active threads (all types, including forum posts still open)
const active = await api(`/guilds/${GUILD}/threads/active`);
for (const t of active.threads ?? []) {
  targets.set(t.id, { id: t.id, name: t.name, type: t.type, parentId: t.parent_id, kind: 'thread-active' });
}

// archived threads under every thread-capable parent
for (const c of channels.filter(x => THREAD_PARENT.has(x.type))) {
  for (const route of ['public', 'private']) {
    let before = null, guard = 0;
    for (;;) {
      const q = `/channels/${c.id}/threads/archived/${route}?limit=100${before ? `&before=${before}` : ''}`;
      const page = await api(q);
      if (page.__denied || !page.threads) break;
      for (const t of page.threads) {
        targets.set(t.id, { id: t.id, name: t.name, type: t.type, parentId: c.id, kind: `thread-archived-${route}` });
      }
      if (!page.has_more || page.threads.length === 0 || ++guard > 60) break;
      const last = page.threads[page.threads.length - 1];
      before = last.thread_metadata?.archive_timestamp ?? null;
      if (!before) break;
    }
  }
}

say(`# ${channels.length} channels listed · ${targets.size} messageable containers (incl. threads)`);

// ── sweep ────────────────────────────────────────────────────────────────────
const jsonl = createWriteStream(JSONL);
const humans = new Map();   // userId -> {name, globalName, count, channels:Set, first, last}
const bots = new Map();     // authorId/webhook -> {name, count}
const perChannel = [];
const denied = [];
let totalMsgs = 0, humanMsgs = 0, botMsgs = 0;

const list = [...targets.values()];
for (let i = 0; i < list.length; i++) {
  const ch = list[i];
  let before = null, seen = 0, chHumans = new Set(), chHuman = 0, chBot = 0, oldest = null, newest = null;
  let readable = true;

  for (;;) {
    const page = await api(`/channels/${ch.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
    if (page.__denied) { readable = false; denied.push({ ...ch, status: page.__denied }); break; }
    if (!Array.isArray(page) || page.length === 0) break;

    let hitCutoff = false;
    for (const m of page) {
      const ts = Date.parse(m.timestamp);
      if (ts < CUTOFF_MS) { hitCutoff = true; continue; }
      seen++; totalMsgs++;
      newest = newest === null ? ts : Math.max(newest, ts);
      oldest = oldest === null ? ts : Math.min(oldest, ts);

      const isBot = Boolean(m.author?.bot) || Boolean(m.webhook_id);
      const a = m.author ?? {};
      if (isBot) {
        botMsgs++; chBot++;
        const key = m.webhook_id ? `webhook:${m.webhook_id}` : `bot:${a.id}`;
        const e = bots.get(key) ?? { key, name: a.username ?? '(unknown)', id: a.id ?? null, count: 0 };
        e.count++; bots.set(key, e);
      } else {
        humanMsgs++; chHuman++; chHumans.add(a.id);
        const e = humans.get(a.id) ?? {
          id: a.id, username: a.username, globalName: a.global_name ?? null,
          count: 0, channels: new Set(), first: ts, last: ts,
        };
        e.count++; e.channels.add(ch.id);
        e.first = Math.min(e.first, ts); e.last = Math.max(e.last, ts);
        if (!e.globalName && a.global_name) e.globalName = a.global_name;
        humans.set(a.id, e);
      }
      jsonl.write(JSON.stringify({
        c: ch.id, cn: ch.name, m: m.id, t: m.timestamp,
        u: a.id ?? null, un: a.username ?? null, bot: isBot, wh: m.webhook_id ?? null,
        type: m.type, len: (m.content ?? '').length,
        att: (m.attachments ?? []).length, emb: (m.embeds ?? []).length,
      }) + '\n');
    }

    const last = page[page.length - 1];
    if (hitCutoff || page.length < 100 || BigInt(last.id) <= BigInt(CUTOFF_SNOWFLAKE)) break;
    before = last.id;
  }

  if (readable) {
    perChannel.push({ id: ch.id, name: ch.name, kind: ch.kind, category: ch.category ?? null,
      messages: seen, humanMessages: chHuman, botMessages: chBot, uniqueHumans: chHumans.size,
      oldest: oldest ? new Date(oldest).toISOString() : null,
      newest: newest ? new Date(newest).toISOString() : null });
  }
  say(`[${String(i + 1).padStart(3)}/${list.length}] ${readable ? String(seen).padStart(6) : '  DENY'}  ${ch.kind === 'channel' ? '#' : '↳'}${ch.name}`);
}

// await the flush — process.exit() below would truncate the tail of the buffer otherwise
await new Promise((res, rej) => { jsonl.once('finish', res); jsonl.once('error', rej); jsonl.end(); });

// ── report ───────────────────────────────────────────────────────────────────
const roster = [...humans.values()]
  .map(h => ({ id: h.id, username: h.username, displayName: h.globalName ?? h.username,
    messages: h.count, channelsPostedIn: h.channels.size,
    firstPost: new Date(h.first).toISOString(), lastPost: new Date(h.last).toISOString() }))
  .sort((a, b) => b.messages - a.messages);

const report = {
  guild: { id: GUILD, name: guild.name, approximateMembers: guild.approximate_member_count },
  window: { days: DAYS, from: new Date(CUTOFF_MS).toISOString(), to: new Date().toISOString() },
  scanned: { containers: list.length, readable: perChannel.length, denied: denied.length, apiCalls: calls },
  totals: {
    messages: totalMsgs,
    humanMessages: humanMsgs,
    botAndWebhookMessages: botMsgs,
    uniqueHumanPosters: humans.size,
    uniqueBotOrWebhookAuthors: bots.size,
  },
  posters: roster,
  bots: [...bots.values()].sort((a, b) => b.count - a.count),
  channels: perChannel.sort((a, b) => b.messages - a.messages),
  deniedChannels: denied,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));

say('');
say(`UNIQUE HUMAN POSTERS : ${humans.size}`);
say(`HUMAN MESSAGES       : ${humanMsgs}`);
say(`BOT/WEBHOOK MESSAGES : ${botMsgs}`);
say(`TOTAL MESSAGES       : ${totalMsgs}`);
say(`DENIED CHANNELS      : ${denied.length}`);
say(`API CALLS            : ${calls}`);
say(`report -> ${OUT}`);
say(`raw    -> ${JSONL}`);
process.exit(0);
