// Final audit for The Bat Cave: for each non-CertiFried bot in the server,
// list what role/permissions it holds and check whether each function we
// know it provides has been replaced by CertiFried.

import 'dotenv/config';
import pool from '../utils/db.js';

const GUILD = '800157336458231848';
const token = process.env.DISCORD_TOKEN;

async function api(method, path) {
  await new Promise(r => setTimeout(r, 50));
  const r = await fetch(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${token}` } });
  if (!r.ok) return { __err: `${r.status}: ${(await r.text()).slice(0,200)}` };
  return r.status === 204 ? null : r.json();
}

// Replacement matrix — what CertiFried now handles
const REPLACED = {
  'Streamcord':       { role: '872806508193267753',  duty: 'Twitch live announcements',         certifried: '✅ presenceUpdate.js auto-detect + #bats-reccomendations' },
  'Twitch Alerts 🔔': { role: '1300545482581610499', duty: 'Twitch live announcements + ping', certifried: '✅ Live Notify role + same presence detection' },
  'NotifyMe':         { role: '1381917652951502849', duty: 'Twitch live announcements',         certifried: '✅ presenceUpdate.js auto-detect' },
  'Sx Bot':           { role: '1371923503946928253', duty: 'Twitch live announcements',         certifried: '✅ presenceUpdate.js auto-detect' },
  'Maki.gg':          { role: '1298109705025093666', duty: 'Twitch alerts (unconfirmed)',       certifried: '✅ presenceUpdate.js auto-detect (if used for streams)' },
  'carl-bot':         { role: '1027706477340803167', duty: 'Rules ✅ reaction → Gotham Citizen', certifried: '✅ New "I Agree" button on rules embed grants Gotham Citizen' },
  'Sapphire':         { role: '1439844630828028006', duty: 'Welcome messages with cards',       certifried: '✅ welcome_settings + greeting-manager.js → #welcome' },
  'Dyno':             { role: '800525371229208578', duty: 'General moderation / automod (unknown specifics)', certifried: '⚠ Verify: do users still use !mod commands? Adaptive spam + anti-nuke + phishing now via CertiFried.' },
  'Rumble Royale':    { role: '1293327567381725197', duty: 'Game bot — battles / events',       certifried: '❌ Not replaced — leave running OR confirm not needed' },
  'Royale':           { role: '1293388746481336371', duty: 'Game bot variant',                  certifried: '❌ Not replaced — leave running OR confirm not needed' },
  'Husband':          { role: '800184758524313640', duty: 'Custom roleplay bot (admin perms)',  certifried: '❌ Bespoke — not in scope, leave running' },
  'Mschief Managed':  { role: '1286929233842540585', duty: 'Custom bot (admin perms)',          certifried: '❌ Bespoke — not in scope, leave running' },
  'The Chicken Man':  { role: '1261180788628783188', duty: 'Custom bot (admin perms)',          certifried: '❌ Bespoke — not in scope, leave running' },
  'Cockawoosing':     { role: '1261182211164606464', duty: 'Custom bot (admin perms)',          certifried: '❌ Bespoke — not in scope, leave running' },
  'Bot Manager':      { role: '1503922180176613477', duty: 'Owner-level bot',                   certifried: '❌ Bespoke — out of scope' },
};

console.log('\n=== Bot audit for The Bat Cave ===\n');

const members = [];
let after = '0';
while (true) {
  const batch = await api('GET', `/guilds/${GUILD}/members?limit=1000&after=${after}`);
  if (!Array.isArray(batch) || batch.length === 0) break;
  for (const m of batch) if (m.user.bot) members.push(m);
  if (batch.length < 1000) break;
  after = batch[batch.length - 1].user.id;
}

console.log(`Found ${members.length} bot members in the guild\n`);
console.log('| Bot | Status | CertiFried Replacement | Suggested Action |');
console.log('| --- | --- | --- | --- |');

const okToRemove = [];
const reviewBeforeRemove = [];
const keep = [];

for (const bot of members) {
  const name = bot.user.username;
  const rec = REPLACED[name];
  if (!rec) {
    console.log(`| ${name} | ❓ unknown | — | review manually |`);
    reviewBeforeRemove.push(name);
    continue;
  }
  const cellStatus = rec.certifried.startsWith('✅') ? '✅ replaced'
                   : rec.certifried.startsWith('⚠') ? '⚠ partial'
                   : '❌ keep';
  let action = '';
  if (rec.certifried.startsWith('✅')) { action = 'OK to remove'; okToRemove.push(name); }
  else if (rec.certifried.startsWith('⚠')) { action = 'Verify Dyno commands not in use'; reviewBeforeRemove.push(name); }
  else { action = 'Keep — not replaced by CertiFried'; keep.push(name); }
  console.log(`| ${name} | ${cellStatus} | ${rec.duty} | ${action} |`);
}

console.log('\n=== Summary ===');
console.log(`OK to remove now (${okToRemove.length}):           ${okToRemove.join(', ') || '(none)'}`);
console.log(`Review before removing (${reviewBeforeRemove.length}):  ${reviewBeforeRemove.join(', ') || '(none)'}`);
console.log(`Keep — outside scope (${keep.length}):          ${keep.join(', ') || '(none)'}`);

console.log('\n=== Existing CertiFried state confirmation ===');
const [logCfg] = await pool.execute('SELECT log_channel_id, enabled FROM logging_config WHERE guild_id=?', [GUILD]);
const [welCfg] = await pool.execute('SELECT channel_id, banner_enabled FROM welcome_settings WHERE guild_id=?', [GUILD]);
const [autoTrack] = await pool.execute('SELECT role_id, announcement_channel_id, live_role_id FROM guild_streamer_auto_track WHERE guild_id=?', [GUILD]);
const [tickets] = await pool.execute('SELECT panel_id, panel_channel_id, ticket_category_id FROM ticket_panels WHERE guild_id=? AND is_active=1', [GUILD]);
const [rrPanels] = await pool.execute('SELECT id, panel_name, channel_id FROM reaction_role_panels WHERE guild_id=?', [GUILD]);
const [subs] = await pool.execute('SELECT COUNT(*) AS n FROM subscriptions WHERE guild_id=?', [GUILD]);
const [secAR] = await pool.execute('SELECT is_enabled, alert_channel_id FROM anti_raid_config WHERE guild_id=?', [GUILD]);
const [secAS] = await pool.execute('SELECT enabled FROM adaptive_spam_config WHERE guild_id=?', [GUILD]);
const [secAN] = await pool.execute('SELECT enabled FROM anti_nuke_config WHERE guild_id=?', [GUILD]);
const [secPh] = await pool.execute('SELECT enabled FROM phishing_config WHERE guild_id=?', [GUILD]);

console.log(`logging_config:             ch=${logCfg[0]?.log_channel_id} enabled=${logCfg[0]?.enabled}`);
console.log(`welcome_settings:           ch=${welCfg[0]?.channel_id} banner=${welCfg[0]?.banner_enabled}`);
console.log(`guild_streamer_auto_track:  role_id=${autoTrack[0]?.role_id || 'NULL (open)'} announce=${autoTrack[0]?.announcement_channel_id} live_role=${autoTrack[0]?.live_role_id}`);
console.log(`ticket_panels (active):     ${tickets.length} (panel ${tickets[0]?.panel_id} in ${tickets[0]?.panel_channel_id})`);
console.log(`reaction_role_panels:       ${rrPanels.length} (${rrPanels.map(p=>`${p.id}:${p.panel_name}`).join(', ')})`);
console.log(`subscriptions:              ${subs[0]?.n}`);
console.log(`anti_raid:                  ${secAR[0]?.is_enabled ? '✓ enabled' : '✗ disabled'}`);
console.log(`adaptive_spam:              ${secAS[0]?.enabled ? '✓ enabled' : '✗ disabled'}`);
console.log(`anti_nuke:                  ${secAN[0]?.enabled ? '✓ enabled' : '✗ disabled'}`);
console.log(`phishing:                   ${secPh[0]?.enabled ? '✓ enabled' : '✗ disabled'}`);

await pool.end();
