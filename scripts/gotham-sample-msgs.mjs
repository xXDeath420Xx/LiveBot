// Pull a recent slice of messages from #bats-reccomendations to identify
// each posting bot and its embed shape, so the full-history scraper can
// be platform/format-aware. Also try to fetch the reference welcome-card
// message 1503921439630426232 from each candidate channel.

import 'dotenv/config';
import pool from '../utils/db.js';

const GUILD = '800157336458231848';
const STREAMER_CH = '1038268111029280778';
const SAMPLE_MSG = '1503921439630426232';

const token = process.env.DISCORD_TOKEN;
async function api(method, path) {
  const r = await fetch(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${token}` } });
  if (!r.ok) return { __err: `${r.status}: ${(await r.text()).slice(0,200)}` };
  return r.status === 204 ? null : r.json();
}

console.log('\n>>> 30 recent messages in #bats-reccomendations — bot byline + embed shape sketch');
const msgs = await api('GET', `/channels/${STREAMER_CH}/messages?limit=30`);
const byAuthor = new Map();
for (const m of msgs) {
  const key = `${m.author?.bot ? 'BOT ' : 'USR '}${m.author?.username || m.webhook_id || '?'} (${m.author?.id || ''})`;
  if (!byAuthor.has(key)) byAuthor.set(key, []);
  byAuthor.get(key).push(m);
}
for (const [author, ms] of byAuthor.entries()) {
  console.log(`\n--- ${author} — ${ms.length} msg(s) ---`);
  const sample = ms[0];
  console.log(`  msg id ${sample.id} ts ${sample.timestamp}`);
  if (sample.content) console.log(`  content: ${sample.content.slice(0, 200).replace(/\n/g, ' / ')}`);
  for (const e of sample.embeds || []) {
    console.log(`  embed: title="${e.title?.slice(0,80)}" url=${e.url}`);
    console.log(`         author.name=${e.author?.name} author.url=${e.author?.url}`);
    console.log(`         desc=${(e.description || '').slice(0, 200).replace(/\n/g, ' / ')}`);
    if (e.fields) for (const f of e.fields.slice(0, 3)) console.log(`         field "${f.name}": ${(f.value||'').slice(0,80)}`);
  }
}

console.log('\n>>> Trying to find reference welcome-card message ' + SAMPLE_MSG);
// 1503921439630426232 created around 2026-05-12 — try across our other known guilds
const CANDIDATE_GUILDS = ['1216126780767731722', '1099732505243959407', '1485188364318539837', '1469931133981687873', '880656752297783347', '869577842088878130', '980331356196311070'];
for (const gid of CANDIDATE_GUILDS) {
  const channels = await api('GET', `/guilds/${gid}/channels`);
  if (!Array.isArray(channels)) continue;
  for (const c of channels) {
    if (c.type !== 0 && c.type !== 5) continue;
    const m = await api('GET', `/channels/${c.id}/messages/${SAMPLE_MSG}`);
    if (!m.__err) {
      console.log(`  FOUND in guild ${gid} channel ${c.id} #${c.name}`);
      console.log(JSON.stringify({ id: m.id, author: m.author?.username, content: m.content?.slice(0,200), embeds: m.embeds }, null, 2).slice(0, 1500));
      process.exit(0);
    }
  }
}
console.log('  not found in known guilds');

await pool.end();
