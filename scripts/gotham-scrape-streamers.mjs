// Walk the entire message history of #bats-reccomendations and extract every
// unique (platform, username) ever announced by ANY bot. Outputs a JSON file
// at /tmp/gotham-streamers.json for human review before subscriptions are
// created. Also tries to locate reference welcome-card message in this guild.

import 'dotenv/config';
import fs from 'node:fs';
import pool from '../utils/db.js';

const GUILD = '800157336458231848';
const STREAMER_CH = '1038268111029280778';
const SAMPLE_MSG = '1503921439630426232';
const OUT_FILE = '/tmp/gotham-streamers.json';

const token = process.env.DISCORD_TOKEN;

async function api(method, path) {
  // gentle pacing for rate limits
  await new Promise(r => setTimeout(r, 60));
  const r = await fetch(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${token}` } });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    const wait = Math.ceil((j.retry_after || 1) * 1000) + 200;
    console.log(`  [rate-limited; waiting ${wait}ms]`);
    await new Promise(rs => setTimeout(rs, wait));
    return api(method, path);
  }
  if (!r.ok) return { __err: `${r.status}: ${(await r.text()).slice(0,200)}` };
  return r.status === 204 ? null : r.json();
}

// Platform extractors — return { platform, username } or null
const URL_PATTERNS = [
  { re: /(?:^|[^a-z0-9])twitch\.tv\/([A-Za-z0-9_]{3,32})/i, platform: 'twitch' },
  { re: /(?:^|[^a-z0-9])kick\.com\/([A-Za-z0-9_-]{3,32})/i, platform: 'kick' },
  { re: /(?:^|[^a-z0-9])(?:www\.)?youtube\.com\/(?:c\/|channel\/|user\/|@)([A-Za-z0-9_-]{2,64})/i, platform: 'youtube' },
  { re: /(?:^|[^a-z0-9])(?:www\.)?youtube\.com\/watch\?v=([A-Za-z0-9_-]{6,32})/i, platform: 'youtube-video' }, // discard
  { re: /(?:^|[^a-z0-9])(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,32})/i, platform: 'tiktok' },
  { re: /(?:^|[^a-z0-9])trovo\.live\/([A-Za-z0-9_-]{3,32})/i, platform: 'trovo' },
  { re: /(?:^|[^a-z0-9])(?:fb|facebook)\.gg\/([A-Za-z0-9_.-]{3,64})/i, platform: 'facebook' },
];

function extractFromText(s) {
  if (!s) return [];
  const found = [];
  for (const { re, platform } of URL_PATTERNS) {
    const m = s.match(re);
    if (m && platform !== 'youtube-video') found.push({ platform, username: m[1] });
  }
  return found;
}

function harvestMessage(msg, set, perBot) {
  const fields = [
    msg.content,
    ...(msg.embeds || []).flatMap(e => [
      e.url, e.author?.url, e.title, e.description,
      ...(e.fields || []).map(f => f.value),
    ]),
  ];
  const found = [];
  for (const f of fields) for (const hit of extractFromText(f || '')) found.push(hit);
  // dedupe within this message
  const seen = new Set();
  const unique = found.filter(h => {
    const k = `${h.platform}:${h.username.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (const h of unique) {
    const key = `${h.platform}:${h.username.toLowerCase()}`;
    if (!set.has(key)) {
      set.set(key, {
        platform: h.platform,
        username: h.username, // first-seen capitalization
        first_seen_msg: msg.id,
        first_seen_at: msg.timestamp,
        last_seen_at: msg.timestamp,
        post_count: 1,
        posting_bots: new Set([msg.author?.id || msg.webhook_id || 'unknown']),
      });
    } else {
      const e = set.get(key);
      e.post_count++;
      e.last_seen_at = msg.timestamp > e.last_seen_at ? msg.timestamp : e.last_seen_at;
      e.posting_bots.add(msg.author?.id || msg.webhook_id || 'unknown');
    }
  }

  // bot-level tally
  const author = msg.author?.username || msg.webhook_id || 'unknown';
  if (!perBot.has(author)) perBot.set(author, { id: msg.author?.id || msg.webhook_id, messages: 0, streamer_hits: 0 });
  const stats = perBot.get(author);
  stats.messages++;
  stats.streamer_hits += unique.length;
}

console.log(`\n>>> Scraping all messages in channel ${STREAMER_CH}`);
const streamerSet = new Map();
const perBot = new Map();
let total = 0;
let oldestSeen = null;
let before = null;
let pages = 0;

while (true) {
  pages++;
  const path = `/channels/${STREAMER_CH}/messages?limit=100${before ? `&before=${before}` : ''}`;
  const batch = await api('GET', path);
  if (batch.__err) { console.log(`  ERR ${batch.__err}`); break; }
  if (!Array.isArray(batch) || batch.length === 0) break;

  for (const m of batch) harvestMessage(m, streamerSet, perBot);
  total += batch.length;
  oldestSeen = batch[batch.length - 1].timestamp;
  before = batch[batch.length - 1].id;

  if (pages % 10 === 0) {
    console.log(`  page ${pages}: total=${total} oldest=${oldestSeen} unique_streamers=${streamerSet.size}`);
  }
  if (batch.length < 100) break;
}

console.log(`\n>>> Scrape complete: ${total} messages across ${pages} pages, oldest ${oldestSeen}`);

// Final structuring
const byPlatform = {};
for (const e of streamerSet.values()) {
  if (!byPlatform[e.platform]) byPlatform[e.platform] = [];
  byPlatform[e.platform].push({
    username: e.username,
    post_count: e.post_count,
    first_seen_at: e.first_seen_at,
    last_seen_at: e.last_seen_at,
    posting_bots: [...e.posting_bots],
  });
}
for (const p in byPlatform) byPlatform[p].sort((a, b) => b.post_count - a.post_count);

const output = {
  scraped_at: new Date().toISOString(),
  channel_id: STREAMER_CH,
  total_messages: total,
  oldest_message: oldestSeen,
  posting_bots: Object.fromEntries(
    [...perBot.entries()]
      .sort((a, b) => b[1].streamer_hits - a[1].streamer_hits)
      .map(([name, s]) => [name, s])
  ),
  streamers_by_platform: byPlatform,
};

fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
console.log(`\n>>> Wrote ${OUT_FILE}`);
console.log(`\n>>> Posting bots:`);
for (const [n, s] of Object.entries(output.posting_bots)) {
  console.log(`  ${n.padEnd(40)} messages=${String(s.messages).padStart(5)} streamer_hits=${s.streamer_hits}`);
}
console.log(`\n>>> Unique streamers by platform:`);
for (const [p, arr] of Object.entries(byPlatform)) console.log(`  ${p}: ${arr.length}`);

// Now try to find reference welcome card message in this guild
console.log(`\n>>> Searching The Bat Cave for reference welcome message ${SAMPLE_MSG}`);
const channels = await api('GET', `/guilds/${GUILD}/channels`);
let found = false;
for (const c of channels) {
  if (c.type !== 0 && c.type !== 5) continue;
  const m = await api('GET', `/channels/${c.id}/messages/${SAMPLE_MSG}`);
  if (!m.__err) {
    console.log(`  FOUND in #${c.name} (${c.id})`);
    console.log(JSON.stringify({ id: m.id, author: m.author?.username, content: m.content?.slice(0,300), embeds: m.embeds, attachments: m.attachments }, null, 2).slice(0, 2000));
    found = true;
    break;
  }
}
if (!found) console.log(`  NOT FOUND — user-provided ID may be in a different guild or deleted.`);

await pool.end();
