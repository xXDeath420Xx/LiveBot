// Mirror Twatwaffle's #about-certifried channel into The Bat Cave,
// positioned right below #tech-questions-and-answers (1503912714479730799).
//
// Posts as Harley's Bat (current owner of the guild).

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '800157336458231848';
const ANCHOR_CH = '1503912714479730799'; // #tech-questions-and-answers
const SOURCE_CH = '1496641417173532683'; // Twatwaffle's #about-certifried

const HARLEY_BOT_ID    = '1503936879635202149';
const TWATWAFFLE_BOT   = '1496352090950467595';

const [[h], [t]] = await Promise.all([
  pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [HARLEY_BOT_ID]),
  pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [TWATWAFFLE_BOT]),
]);
const harleyToken = encryption.decrypt(JSON.parse(h[0].bot_token));
const twatToken   = encryption.decrypt(JSON.parse(t[0].bot_token));

async function api(token, method, path, body) {
  await new Promise(r => setTimeout(r, 100));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 200));
    return api(token, method, path, body);
  }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${(await r.text()).slice(0,300)}`);
  return r.status === 204 ? null : r.json();
}

console.log('=== Mirror #about-certifried into The Bat Cave ===\n');

// 1. Fetch source content (oldest-first)
console.log('[1] Fetching source messages from Twatwaffle…');
const srcMsgs = (await api(twatToken, 'GET', `/channels/${SOURCE_CH}/messages?limit=50`)).reverse();
console.log(`    found ${srcMsgs.length} source message(s)`);

// 2. Find anchor channel's position + parent
console.log('\n[2] Locating anchor channel in Gotham…');
const anchor = await api(harleyToken, 'GET', `/channels/${ANCHOR_CH}`);
console.log(`    anchor "${anchor.name}" type=${anchor.type} pos=${anchor.position} parent=${anchor.parent_id}`);

// 3. Create / find #about-certifried in Gotham
console.log('\n[3] Creating #about-certifried in Gotham (same parent category)…');
const channels = await api(harleyToken, 'GET', `/guilds/${GUILD}/channels`);
let target = channels.find(c => c.name === 'about-certifried' && c.type === 0);
if (target) {
  console.log(`    reused existing ${target.id}`);
} else {
  target = await api(harleyToken, 'POST', `/guilds/${GUILD}/channels`, {
    name: 'about-certifried',
    type: 0,
    parent_id: anchor.parent_id,
    topic: 'About the CertiFried bot — features, dashboard, invite info.',
    permission_overwrites: [
      { id: GUILD, type: 0, allow: '0', deny: '2048' }, // @everyone deny SEND (view OK via inherited)
    ],
  });
  console.log(`    created ${target.id} #${target.name}`);
}

// 4. Move it to position = anchor.position + 1 (right below the anchor)
console.log('\n[4] Positioning right below anchor…');
await api(harleyToken, 'PATCH', `/guilds/${GUILD}/channels`, [
  { id: target.id, position: anchor.position + 1, parent_id: anchor.parent_id },
]);
console.log(`    moved to position ${anchor.position + 1}`);

// 5. Post the source messages' embeds via Harley's Bat
console.log('\n[5] Posting content…');
// First check if Harley's Bat already posted there
const existing = await api(harleyToken, 'GET', `/channels/${target.id}/messages?limit=10`);
if (existing.length > 0) {
  console.log(`    channel already has ${existing.length} message(s) — skipping repost`);
} else {
  for (const src of srcMsgs) {
    if (!src.content && !src.embeds?.length) continue;
    const posted = await api(harleyToken, 'POST', `/channels/${target.id}/messages`, {
      content: src.content || undefined,
      embeds: src.embeds?.length ? src.embeds : undefined,
    });
    console.log(`    posted ${posted.id} (embeds=${src.embeds?.length || 0}, content=${src.content ? src.content.length + 'ch' : 'none'})`);
  }
}

console.log('\nDone.');
console.log(`#about-certifried lives at ${target.id}, right below #tech-questions-and-answers.`);

await pool.end();
