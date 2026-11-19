/*
 * READ-ONLY: everything MEE6's custom bot (app 1347110732520493056) still owns or does in
 * 𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 985116833193553930. REST-only via the guild's resolved bot token.
 *   node scripts/_audit-teamaura-mee6.mjs            structure + audit log + MEE6 API
 *   node scripts/_audit-teamaura-mee6.mjs --messages  full-history sweep of its posts
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const G = '985116833193553930';
const MEE6 = '1347110732520493056'; // bot-id-ok: the third-party bot being audited, not one of ours
const db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
process.on('unhandledRejection', (e) => { console.error('FAILED:', e?.message ?? e); process.exit(1); });
const bot = await resolveBotForGuild(G, { db }); await db.end();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let a = 0; a < 8; a++) {
    const res = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${bot.token}` } });
    if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep((j.retry_after ?? 1) * 1000 + 250); continue; }
    if (!res.ok) return { __err: res.status, body: await res.text() };
    return res.json();
  }
  throw new Error('rate-limited out ' + path);
}
const channels = await get(`/guilds/${G}/channels`);
const cname = (id) => channels.find((c) => c.id === id)?.name ?? id;

if (process.argv.includes('--messages')) {
  const active = await get(`/guilds/${G}/threads/active`);
  const threads = [...(active.threads || [])];
  for (const c of channels.filter((c) => [0, 5, 15, 16].includes(c.type))) for (const kind of ['public', 'private']) {
    let before;
    for (;;) {
      const r = await get(`/channels/${c.id}/threads/archived/${kind}?limit=100${before ? `&before=${before}` : ''}`);
      if (r.__err || !r.threads) break;
      threads.push(...r.threads);
      if (!r.has_more || !r.threads.length) break;
      before = r.threads.at(-1).thread_metadata.archive_timestamp;
    }
  }
  const all = [...channels.filter((c) => [0, 5, 2, 13].includes(c.type)), ...threads];
  const hits = [];
  for (const c of all) {
    let before;
    for (;;) {
      const r = await get(`/channels/${c.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
      if (r.__err || !r.length) break;
      for (const m of r) if (m.author.id === MEE6 || m.application_id === MEE6 || m.interaction_metadata?.user && m.author.id === MEE6)
        hits.push({ channel: c.name, channel_id: c.id, id: m.id, ts: m.timestamp, webhook: !!m.webhook_id, interaction: m.interaction_metadata?.name ?? m.interaction?.name, content: m.content, embeds: m.embeds, components: m.components, pinned: m.pinned });
      before = r.at(-1).id;
      if (r.length < 100) break;
    }
  }
  writeFileSync(process.argv.at(-1).endsWith('.json') ? process.argv.at(-1) : 'mee6-msgs.json', JSON.stringify(hits, null, 1));
  const t = {};
  for (const h of hits) { const k = h.channel; t[k] ??= { n: 0, last: '', kinds: {} }; t[k].n++; if (h.ts > t[k].last) t[k].last = h.ts;
    const kind = h.interaction ? `/${h.interaction}` : (h.embeds[0]?.title || h.embeds[0]?.author?.name || h.content || '(components)').replace(/\s+/g, ' ').replace(/<@!?\d+>/g, '@user').replace(/\d+/g, '#').slice(0, 50); t[k].kinds[kind] = (t[k].kinds[kind] || 0) + 1; }
  for (const [k, v] of Object.entries(t).sort((a, b) => b[1].last.localeCompare(a[1].last)))
    console.log(`${v.n}\t${k}\tlast ${v.last.slice(0, 10)}\t${Object.entries(v.kinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([x, n]) => `${n}× ${x}`).join(' | ')}`);
  console.log('total', hits.length);
  process.exit(0);
}

const member = await get(`/guilds/${G}/members/${MEE6}`);
const roles = await get(`/guilds/${G}/roles`);
console.log('MEMBER', member.user?.username, 'joined', member.joined_at?.slice(0, 10), 'roles', member.roles?.map((r) => roles.find((x) => x.id === r)?.name));
const integ = await get(`/guilds/${G}/integrations`);
for (const i of Array.isArray(integ) ? integ : [integ]) if (i.application?.id === MEE6 || i.account?.id === MEE6) console.log('INTEGRATION', i.name, 'scopes', i.scopes, 'since', i.application?.bot ? '' : '');
const hooks = await get(`/guilds/${G}/webhooks`);
console.log('WEBHOOKS (all):'); for (const h of Array.isArray(hooks) ? hooks : []) console.log(' ', h.application_id === MEE6 ? '[MEE6]' : '      ', h.id, h.name, '->', cname(h.channel_id), '| app', h.application_id, '| by', h.user?.username);
const am = await get(`/guilds/${G}/auto-moderation/rules`);
for (const r of Array.isArray(am) ? am : []) console.log('AUTOMOD', r.creator_id === MEE6 ? '[MEE6]' : '      ', r.name, 'enabled', r.enabled, 'by', r.creator_id);
const mee6Role = roles.find((r) => r.tags?.bot_id === MEE6);
for (const c of channels) for (const o of c.permission_overwrites || []) if (o.id === MEE6 || o.id === mee6Role?.id) console.log('OVERWRITE', c.name, o.type === 1 ? 'member' : 'role', 'allow', o.allow, 'deny', o.deny);
const ev = await get(`/guilds/${G}/scheduled-events`); for (const e of Array.isArray(ev) ? ev : []) if (e.creator_id === MEE6) console.log('EVENT', e.name);
// audit log: everything MEE6 did, newest first (Discord keeps 45 days)
const acts = {}; let before; let n = 0;
for (;;) {
  const r = await get(`/guilds/${G}/audit-logs?user_id=${MEE6}&limit=100${before ? `&before=${before}` : ''}`);
  if (r.__err) { console.log('AUDIT ERR', r.__err, r.body.slice(0, 100)); break; }
  for (const e of r.audit_log_entries) {
    n++;
    const detail = (e.changes || []).map((c) => c.key === '$add' || c.key === '$remove' ? `${c.key}:${c.new_value.map((x) => x.name).join('+')}` : c.key).join(',');
    const k = `type ${e.action_type} ${detail} ${e.options?.channel_id ? 'in ' + cname(e.options.channel_id) : ''} ${e.reason ? '"' + e.reason.slice(0, 40) + '"' : ''}`.trim();
    acts[k] ??= { n: 0, last: e.id }; acts[k].n++;
  }
  if (r.audit_log_entries.length < 100) break;
  before = r.audit_log_entries.at(-1).id;
}
const snow = (id) => new Date(Number(BigInt(id) >> 22n) + 1420070400000).toISOString().slice(0, 16);
console.log(`AUDIT LOG: ${n} actions by MEE6 in the last 45 days`);
for (const [k, v] of Object.entries(acts).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${v.n}× ${k}  (last ${snow(v.last)})`);
const lb = await fetch(`https://mee6.xyz/api/plugins/levels/leaderboard/${G}?limit=5`);
const lj = await lb.json().catch(() => null);
console.log('MEE6 LEVELS API', lb.status, lj?.players ? `${lj.players.length} shown; top: ${lj.players.map((p) => `${p.username} L${p.level}`).join(', ')} | role rewards: ${(lj.role_rewards || []).map((r) => `L${r.rank}->${r.role?.name}`).join(', ')}` : JSON.stringify(lj)?.slice(0, 200));
