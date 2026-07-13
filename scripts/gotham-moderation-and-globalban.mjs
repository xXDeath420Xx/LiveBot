// Configure /admin moderation + /globalban for The Bat Cave.
//
//   moderation_config: muted_role_id + mod_log_channel_id
//   global_ban_config: replicate Twatwaffle's profile (enabled, ban/ban/kick/alert,
//     check_on_join=1, alert_channel_id=#server-logs, log_actions=1, auto_aggregate_opt_in=1)
//
// Creates a Muted role if none exists, denying SEND/SPEAK at the guild level.

import 'dotenv/config';
import pool from '../utils/db.js';

const GUILD = '800157336458231848';
const LOG_CH = '1503938669294125126';  // #server-logs
const MOD_CHAT = '1466492477400809493'; // #mod-chat

const token = process.env.DISCORD_TOKEN;

async function api(method, path, body) {
  await new Promise(r => setTimeout(r, 60));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${(await r.text()).slice(0,250)}`);
  return r.status === 204 ? null : r.json();
}

console.log('=== Gotham moderation + global-ban setup ===\n');

// 1. Find or create Muted role
console.log('[1] Locating/creating Muted role…');
const roles = await api('GET', `/guilds/${GUILD}/roles`);
let mutedRole = roles.find(r => /^muted$/i.test(r.name) && !r.managed);
if (mutedRole) {
  console.log(`    reused ${mutedRole.id} "${mutedRole.name}"`);
} else {
  mutedRole = await api('POST', `/guilds/${GUILD}/roles`, {
    name: 'Muted',
    color: 0x607d8b, // muted grey
    hoist: false,
    mentionable: false,
    permissions: '0',
  });
  console.log(`    created ${mutedRole.id} "Muted"`);
}
const MUTED_ROLE = mutedRole.id;

// 2. Lock the Muted role out of speaking — set per-channel deny SEND_MESSAGES + SPEAK + ADD_REACTIONS
console.log('\n[2] Applying Muted role channel overwrites server-wide…');
const SEND      = 1n << 11n;   // 2048
const SPEAK     = 1n << 21n;   // 2097152
const ADD_REACT = 1n << 6n;    // 64
const DENY_MASK = String(SEND | SPEAK | ADD_REACT);

const channels = await api('GET', `/guilds/${GUILD}/channels`);
let touched = 0;
for (const ch of channels) {
  if (ch.type === 4) continue; // skip categories — overwrites flow down to children by default
  const overwrites = (ch.permission_overwrites || []).map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
  const idx = overwrites.findIndex(o => o.id === MUTED_ROLE && o.type === 0);
  if (idx >= 0) {
    const newDeny = String(BigInt(overwrites[idx].deny || '0') | SEND | SPEAK | ADD_REACT);
    if (newDeny !== overwrites[idx].deny) {
      overwrites[idx].deny = newDeny;
      await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });
      touched++;
    }
  } else {
    overwrites.push({ id: MUTED_ROLE, type: 0, allow: '0', deny: DENY_MASK });
    await api('PATCH', `/channels/${ch.id}`, { permission_overwrites: overwrites });
    touched++;
  }
}
console.log(`    applied to ${touched}/${channels.length - channels.filter(c => c.type === 4).length} channels`);

// 3. moderation_config
console.log('\n[3] Upserting moderation_config…');
await pool.execute(
  `INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id)
   VALUES (?, ?, ?)
   ON DUPLICATE KEY UPDATE mod_log_channel_id=VALUES(mod_log_channel_id), muted_role_id=VALUES(muted_role_id)`,
  [GUILD, LOG_CH, MUTED_ROLE]
);
console.log(`    mod_log_channel_id=#server-logs (${LOG_CH})  muted_role_id=${MUTED_ROLE}`);

// 4. global_ban_config — Twatwaffle profile
console.log('\n[4] Upserting global_ban_config…');
await pool.execute(
  `INSERT INTO global_ban_config (guild_id, enabled, action_critical, action_high, action_medium, action_low, alert_channel_id, log_actions, check_on_join, check_on_message, auto_aggregate_opt_in)
   VALUES (?, 1, 'ban', 'ban', 'kick', 'alert', ?, 1, 1, 0, 1)
   ON DUPLICATE KEY UPDATE enabled=1, action_critical=VALUES(action_critical), action_high=VALUES(action_high), action_medium=VALUES(action_medium), action_low=VALUES(action_low), alert_channel_id=VALUES(alert_channel_id), log_actions=1, check_on_join=1, check_on_message=0, auto_aggregate_opt_in=1`,
  [GUILD, MOD_CHAT]
);
console.log(`    enabled=1, critical=ban high=ban medium=kick low=alert  alert_channel=#mod-chat`);

console.log('\n=== Summary ===');
console.log(`Muted role:            ${MUTED_ROLE} ("Muted") — applied deny SEND/SPEAK/REACT on ${touched} channels`);
console.log(`moderation_config:     mod_log=#server-logs, muted=${MUTED_ROLE}`);
console.log(`global_ban_config:     enabled, check_on_join=1, action profile=ban/ban/kick/alert → #mod-chat`);

await pool.end();
console.log('\nDone.');
