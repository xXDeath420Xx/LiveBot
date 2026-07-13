// Fix regression in gotham-harden-channel-perms.mjs:
//
// Channels that already had `@everyone deny VIEW_CHANNEL` set BEFORE the
// hardening run (e.g. #Ultra Secret VC, #The Bat Hideout VC) are
// member-invite-only — they relied on the @everyone deny + specific
// MEMBER overwrites. My harden script added `Gotham Citizen allow VIEW` to
// them, which broke the lockdown (Citizens saw what only specific invited
// members were supposed to see).
//
// This script:
//   1. Finds every channel where @everyone has a deny that INCLUDES VIEW_CHANNEL.
//   2. Removes the Citizen role overwrite from those channels (so the
//      @everyone deny VIEW is no longer overridden by Citizen).
//   3. Preserves member overwrites verbatim.
//   4. Reports a diff for manual review.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '800157336458231848';
const HARLEY_BOT_ID = '1503936879635202149';
const CITIZEN_ROLE = '800252381513777158';
const VIEW = 1024n;

const [row] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [HARLEY_BOT_ID]);
const token = encryption.decrypt(JSON.parse(row[0].bot_token));

async function api(method, path, body) {
  await new Promise(r => setTimeout(r, 80));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 200));
    return api(method, path, body);
  }
  if (!r.ok) return { __err: { status: r.status, body: (await r.text()).slice(0, 250) } };
  return r.status === 204 ? null : r.json();
}

console.log('=== Member-private channel fix ===\n');

const channels = await api('GET', `/guilds/${GUILD}/channels`);

const memberPrivate = [];
for (const ch of channels) {
  if (ch.type === 4) continue; // skip categories
  const ow = ch.permission_overwrites || [];
  const everyoneOw = ow.find(o => o.id === GUILD);
  if (!everyoneOw) continue;
  const denyHasView = (BigInt(everyoneOw.deny || '0') & VIEW) === VIEW;
  if (denyHasView) memberPrivate.push(ch);
}

console.log(`Found ${memberPrivate.length} member-private channel(s) (@everyone denies VIEW):`);
for (const ch of memberPrivate) {
  console.log(`  ${ch.id}  type=${ch.type}  #${ch.name}`);
}
console.log('');

// Identify member overwrites already on each (for sanity)
for (const ch of memberPrivate) {
  const members = (ch.permission_overwrites || []).filter(o => o.type === 1);
  console.log(`  #${ch.name}: ${members.length} member overwrite(s)`);
  for (const m of members) {
    console.log(`     member ${m.id}  allow=${m.allow}  deny=${m.deny}`);
  }
}
console.log('');

// Remove Citizen overwrite from each
let touched = 0;
for (const ch of memberPrivate) {
  const ow = (ch.permission_overwrites || []).map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
  const idx = ow.findIndex(o => o.id === CITIZEN_ROLE && o.type === 0);
  if (idx === -1) {
    console.log(`  = #${ch.name}: no Citizen overwrite, nothing to do`);
    continue;
  }
  // Remove Citizen overwrite entirely
  ow.splice(idx, 1);
  const r = await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: ow });
  if (r?.__err) {
    console.log(`  ✗ #${ch.name}: ${r.__err.status} ${r.__err.body.slice(0,150)}`);
  } else {
    console.log(`  ✓ #${ch.name}: removed Citizen overwrite`);
    touched++;
  }
}

console.log(`\nDone — ${touched} channel(s) reverted to member-private.`);

await pool.end();
