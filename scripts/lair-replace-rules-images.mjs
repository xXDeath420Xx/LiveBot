// Replace every message in Mama Bear's Lair's rules channel with 7 image
// attachments posted in the order:
//   Welcome → Rules → Adult_Consent → ModBears → SafeSpace → Unsolicited → Shouties
//
// REST-only via CertiFried Bear's bot token. Safe alongside live PM2.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const GUILD_ID  = '1216126780767731722';
const RULES_CH  = '1216603920542208000';
const BOT_ID    = '1496406792417185802';
const DISCORD_EPOCH = 1420070400000n;
const FOURTEEN_DAYS_MS = 14n * 24n * 60n * 60n * 1000n;

const IMAGES_IN_ORDER = [
  'Welcome.png',
  'Rules.png',
  'Adult_Consent.png',
  'ModBears.png',
  'SafeSpace.png',
  'Unsolicited.png',
  'Shouties.png',
];

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
if (rows.length === 0) {
  console.error(`CertiFried Bear bot row not found (bot_id=${BOT_ID})`);
  process.exit(1);
}
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));
const AUTH = `Bot ${token}`;

async function api(method, urlPath, body) {
  await new Promise(r => setTimeout(r, 80));
  const res = await fetch(`https://discord.com/api/v10${urlPath}`, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 250));
    return api(method, urlPath, body);
  }
  if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 250) } };
  return res.status === 204 ? null : res.json();
}

function snowflakeAgeMs(id) {
  return BigInt(Date.now()) - ((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

console.log(`=== Lair rules-channel image refresh — #${RULES_CH} ===\n`);

// ──────────────────────────────────────────────────────────────────────────
// Step 1: purge channel
// ──────────────────────────────────────────────────────────────────────────
let purged = 0;
let errored = 0;
let beforeId = null;

while (true) {
  const q = beforeId ? `?limit=100&before=${beforeId}` : '?limit=100';
  const page = await api('GET', `/channels/${RULES_CH}/messages${q}`);
  if (page?.__err) { console.error('Fetch failed:', page.__err); process.exit(1); }
  if (!page || page.length === 0) break;
  beforeId = page[page.length - 1].id;

  // Unpin any pinned messages so they're deletable
  for (const m of page) {
    if (m.pinned) {
      const r = await api('DELETE', `/channels/${RULES_CH}/pins/${m.id}`);
      if (r?.__err) console.log(`  ! couldn't unpin ${m.id}: ${r.__err.status}`);
      else console.log(`  · unpinned ${m.id}`);
    }
  }

  const young = page.filter(m => snowflakeAgeMs(m.id) < FOURTEEN_DAYS_MS).map(m => m.id);
  const old   = page.filter(m => snowflakeAgeMs(m.id) >= FOURTEEN_DAYS_MS);

  if (young.length >= 2) {
    const r = await api('POST', `/channels/${RULES_CH}/messages/bulk-delete`, { messages: young });
    if (r?.__err) {
      console.log(`  ✗ bulk-delete ${young.length} msgs: ${r.__err.status} ${r.__err.body.slice(0,150)}`);
      errored += young.length;
    } else {
      purged += young.length;
      console.log(`  ✓ bulk-deleted ${young.length} msg(s)`);
    }
  } else if (young.length === 1) {
    const r = await api('DELETE', `/channels/${RULES_CH}/messages/${young[0]}`);
    if (r?.__err) { console.log(`  ✗ delete ${young[0]}: ${r.__err.status}`); errored++; }
    else { purged++; console.log(`  ✓ deleted ${young[0]}`); }
  }

  for (const m of old) {
    const r = await api('DELETE', `/channels/${RULES_CH}/messages/${m.id}`);
    if (r?.__err) { console.log(`  ✗ delete ${m.id}: ${r.__err.status}`); errored++; }
    else { purged++; console.log(`  ✓ deleted ${m.id} (old)`); }
  }

  if (page.length < 100) break;
}

console.log(`\nPurge done — ${purged} message(s) removed, ${errored} error(s)\n`);

// ──────────────────────────────────────────────────────────────────────────
// Step 2: post 7 images in order
// ──────────────────────────────────────────────────────────────────────────
let posted = 0;
for (const filename of IMAGES_IN_ORDER) {
  const abs = path.join(REPO_ROOT, 'docs', filename);
  if (!fs.existsSync(abs)) {
    console.log(`  ✗ ${filename}: file not found at ${abs}`);
    errored++;
    continue;
  }
  const buf = fs.readFileSync(abs);
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({}));
  fd.append('files[0]', new Blob([buf], { type: 'image/png' }), filename);

  await new Promise(r => setTimeout(r, 250));
  const res = await fetch(`https://discord.com/api/v10/channels/${RULES_CH}/messages`, {
    method: 'POST',
    headers: { Authorization: AUTH },
    body: fd,
  });
  if (!res.ok) {
    const txt = await res.text();
    console.log(`  ✗ ${filename}: ${res.status} ${txt.slice(0, 200)}`);
    errored++;
  } else {
    const j = await res.json();
    posted++;
    console.log(`  ✓ ${filename} → message ${j.id}`);
  }
}

console.log('\n=== Summary ===');
console.log(`  Purged:  ${purged}`);
console.log(`  Posted:  ${posted} / ${IMAGES_IN_ORDER.length}`);
console.log(`  Errored: ${errored}`);

await pool.end();
console.log('\nDone.');
