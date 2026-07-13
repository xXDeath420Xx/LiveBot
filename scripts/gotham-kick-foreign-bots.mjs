// Use Harley's Bat to kick every bot in The Bat Cave whose duties have been
// migrated to CertiFried. Keeps: Rumble Royale + owner-bespoke admin bots.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '800157336458231848';
const HARLEY_BOT_ID = '1503936879635202149';

const TO_KICK = {
  '375805687529209857':  'Streamcord',
  '1041679706988228639': 'Twitch Alerts 🔔',
  '1429979095302930493': 'NotifyMe',
  '696870234262339614':  'Sx Bot',
  '678344927997853742':  'Sapphire',
  '235148962103951360':  'Carl-bot',
  '1409904443125665875': 'CertiFried Utility (default — replaced by Harley\'s Bat)',
  // Dyno + Maki.gg only kicked if found in member list
};

const ALSO_KICK_IF_FOUND = [
  'Dyno',
  'Maki.gg',
  'Maki',
];

const KEEP_REASONS = {
  '1503936879635202149': "Harley's Bat — owner of this guild's automation",
  '693167035068317736':  'Rumble Royale — game bot, kept by user',
};

const [row] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [HARLEY_BOT_ID]);
const token = encryption.decrypt(JSON.parse(row[0].bot_token));

async function api(method, path) {
  await new Promise(r => setTimeout(r, 200));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}` },
  });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 200));
    return api(method, path);
  }
  if (r.status === 204) return { ok: true };
  if (!r.ok) return { __err: { status: r.status, body: (await r.text()).slice(0, 250) } };
  return r.json();
}

console.log('=== Kicking foreign bots from The Bat Cave ===\n');

// Enumerate all bot members
const members = [];
let after = '0';
while (true) {
  const batch = await api('GET', `/guilds/${GUILD}/members?limit=1000&after=${after}`);
  if (!Array.isArray(batch) || batch.length === 0) break;
  for (const m of batch) if (m.user.bot) members.push(m);
  if (batch.length < 1000) break;
  after = batch[batch.length - 1].user.id;
}
console.log(`Found ${members.length} bot member(s) in the guild:`);
for (const m of members) console.log(`  ${m.user.id}  ${m.user.username}`);
console.log('');

const kicked = [];
const skipped = [];
const errors = [];

for (const m of members) {
  const id = m.user.id;
  const name = m.user.username;

  if (KEEP_REASONS[id]) {
    skipped.push({ id, name, reason: KEEP_REASONS[id] });
    continue;
  }

  let shouldKick = !!TO_KICK[id];
  if (!shouldKick && ALSO_KICK_IF_FOUND.some(n => name.toLowerCase().includes(n.toLowerCase()))) {
    shouldKick = true;
  }

  if (!shouldKick) {
    skipped.push({ id, name, reason: 'not in replaceable list (owner-bespoke / unknown)' });
    continue;
  }

  console.log(`Kicking ${name} (${id})…`);
  const r = await api('DELETE', `/guilds/${GUILD}/members/${id}`);
  if (r?.__err) {
    errors.push({ id, name, error: `${r.__err.status} ${r.__err.body.slice(0,150)}` });
    console.log(`  ✗ ${r.__err.status}: ${r.__err.body.slice(0,150)}`);
  } else {
    kicked.push({ id, name });
    console.log(`  ✓ removed`);
  }
}

console.log('\n=== Summary ===');
console.log(`Kicked (${kicked.length}):`);
for (const k of kicked) console.log(`  ✓ ${k.name} (${k.id})`);

if (errors.length) {
  console.log(`\nErrors (${errors.length}):`);
  for (const e of errors) console.log(`  ✗ ${e.name} (${e.id}): ${e.error}`);
}

console.log(`\nKept (${skipped.length}):`);
for (const s of skipped) console.log(`  • ${s.name} (${s.id}) — ${s.reason}`);

await pool.end();
