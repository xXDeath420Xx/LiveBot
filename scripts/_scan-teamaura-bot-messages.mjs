/*
 * READ-ONLY full-history sweep of guild 985116833193553930 for messages authored by the
 * outgoing bot (MEE6-style 1347122544376807557) and the ReeferRealm custom bot, plus any
 * webhook messages (persona posts carry a baked-in name/avatar). REST-only via the
 * guild's resolved bot token — safe while PM2 runs.
 *   node scripts/_scan-teamaura-bot-messages.mjs <out.json>
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD = '985116833193553930';
const OLD_BOT = '1347122544376807557'; // bot-id-ok: the third-party bot being replaced, not one of ours
const OUT = process.argv[2] || 'teamaura-scan.json';
const db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, charset: 'utf8mb4' });
process.on('unhandledRejection', (e) => { console.error('FAILED:', e?.message ?? e); process.exit(1); });
const bot = await resolveBotForGuild(GUILD, { db });
await db.end();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let a = 0; a < 8; a++) {
    const res = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${bot.token}` } });
    if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep((j.retry_after ?? 1) * 1000 + 250); continue; }
    if (res.status === 403 || res.status === 404) return { __err: res.status };
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error('rate-limited out ' + path);
}
const me = await get('/users/@me');
const oldBot = await get(`/users/${OLD_BOT}`);
console.log('scanning as', me.id, me.username, '| old bot:', oldBot.username, oldBot.avatar);
const channels = await get(`/guilds/${GUILD}/channels`);
const active = await get(`/guilds/${GUILD}/threads/active`);
const targets = channels.filter((c) => [0, 5, 15, 16, 2, 13].includes(c.type));
const threads = [...(active.threads || [])];
for (const c of targets.filter((c) => [0, 5, 15, 16].includes(c.type))) {
  for (const kind of ['public', 'private']) {
    let before;
    for (;;) {
      const r = await get(`/channels/${c.id}/threads/archived/${kind}?limit=100${before ? `&before=${before}` : ''}`);
      if (r.__err || !r.threads) break;
      threads.push(...r.threads);
      if (!r.has_more || !r.threads.length) break;
      before = r.threads.at(-1).thread_metadata.archive_timestamp;
    }
  }
}
const all = [...targets.filter((c) => ![15, 16].includes(c.type)), ...threads];
const hits = []; const denied = []; let scanned = 0;
for (const c of all) {
  let before; let n = 0;
  for (;;) {
    const r = await get(`/channels/${c.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
    if (r.__err) { denied.push({ id: c.id, name: c.name, err: r.__err }); break; }
    if (!r.length) break;
    for (const m of r) {
      n++;
      const isOld = m.author.id === OLD_BOT;
      const isOurs = m.author.id === me.id || m.application_id === me.id;
      const isHook = !!m.webhook_id;
      if (isOld || isOurs || isHook) hits.push({
        channel_id: c.id, channel: c.name, parent_id: c.parent_id, id: m.id, ts: m.timestamp,
        kind: isOld ? 'old' : isOurs ? 'ours' : 'webhook', author: { id: m.author.id, name: m.author.username, global_name: m.author.global_name, avatar: m.author.avatar },
        webhook_id: m.webhook_id, application_id: m.application_id, type: m.type, flags: m.flags,
        content: m.content, embeds: m.embeds, components: m.components, attachments: m.attachments?.map((a) => ({ url: a.url, filename: a.filename })),
        reactions: m.reactions?.map((x) => ({ emoji: x.emoji, count: x.count })), pinned: m.pinned, interaction: m.interaction_metadata ? { name: m.interaction_metadata.name ?? m.interaction?.name } : undefined,
      });
    }
    before = r.at(-1).id;
    if (r.length < 100) break;
  }
  scanned += n;
}
writeFileSync(OUT, JSON.stringify({ me: { id: me.id, username: me.username, avatar: me.avatar }, oldBot: { id: oldBot.id, username: oldBot.username, avatar: oldBot.avatar }, scanned, channels: all.length, denied, hits }, null, 1));
console.log(`scanned ${scanned} msgs in ${all.length} channels/threads; denied ${denied.length}; hits ${hits.length}`);
const tally = {}; for (const h of hits) { const k = `${h.kind}\t${h.channel}`; tally[k] = (tally[k] || 0) + 1; }
console.log(Object.entries(tally).sort().map(([k, v]) => `${v}\t${k}`).join('\n'));
