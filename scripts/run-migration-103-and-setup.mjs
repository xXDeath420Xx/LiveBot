// 1) Apply migration 103 (voice_channel_guards table).
// 2) Configure Kitsune voice channel guard:
//    - Insert voice_channel_guards row (guild=Kitsune, channel=Sanctuary, allowed=533297810309906444).
//    - Add user-specific allow overwrite (VIEW + CONNECT + SPEAK).
// 3) Configure Twatwaffle two-button signup panel:
//    - Disable existing self_promo_config (URL-parser pipeline).
//    - Find/create "Streamer" status role + "Auto-Add" gated role.
//    - reaction_role_panels row + 2 mappings (Streamer ungated, Auto-Add min_level=3).
//    - PATCH existing message 1496387932561473586 with new embed + 2 buttons.
//    - guild_streamer_auto_track row → Auto-Add role → channel 1496351043372716053.
//
// REST-only — safe alongside live PM2. PM2 restart afterwards picks up
// the new voiceStateUpdate guard logic.

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { up as migrate103 } from '../migrations/103_voice_channel_guards.js';

// --- Constants ----------------------------------------------------------
const KITSUNE_GUILD   = '1469931133981687873';
const KITSUNE_BOT     = '1498486251576229958';
const KITSUNE_CHANNEL = '1502435691412459540';
const ALLOWED_USER    = '533297810309906444';

const TWAT_GUILD   = '1099732505243959407';
const TWAT_BOT     = '1496352090950467595';
const TWAT_SIGNUP  = '1496351044567961620';
const TWAT_OUTPUT  = '1496351043372716053';
const TWAT_MSG     = '1496387932561473586';
const SHOUTOUT_ELIGIBLE_ROLE = '1496351030277968004';
const TWAT_MIN_LEVEL = 3;

const VIEW_CHANNEL = 1024n;
const CONNECT      = 1n << 20n;
const SPEAK        = 1n << 21n;
const SEND_MESSAGES = 2048n;

// --- Bot tokens ---------------------------------------------------------
const [rows] = await pool.execute(
  'SELECT bot_id, bot_token FROM custom_bots WHERE bot_id IN (?, ?)',
  [KITSUNE_BOT, TWAT_BOT]
);
const tokens = Object.fromEntries(rows.map(r => [r.bot_id, encryption.decrypt(JSON.parse(r.bot_token))]));

async function api(botId, method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${tokens[botId]}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// --- 1. Migration 103 ---------------------------------------------------
console.log('\n[1/3] Applying migration 103 (voice_channel_guards)…');
await migrate103(pool);
console.log('       done.');

// --- 2. Kitsune voice channel guard -------------------------------------
console.log('\n[2/3] Kitsune voice channel guard…');

console.log('  - Inserting voice_channel_guards row');
await pool.execute(
  `INSERT INTO voice_channel_guards (guild_id, channel_id, allowed_user_id)
   VALUES (?, ?, ?)
   ON DUPLICATE KEY UPDATE allowed_user_id = VALUES(allowed_user_id)`,
  [KITSUNE_GUILD, KITSUNE_CHANNEL, ALLOWED_USER]
);

console.log('  - Adding user-specific allow overwrite on the voice channel');
const kch = await api(KITSUNE_BOT, 'GET', `/channels/${KITSUNE_CHANNEL}`);
const overwrites = (kch.permission_overwrites || []).map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
const userIdx = overwrites.findIndex(o => o.id === ALLOWED_USER && o.type === 1);
const allowMask = String(VIEW_CHANNEL | CONNECT | SPEAK);
if (userIdx >= 0) {
  overwrites[userIdx].allow = String((BigInt(overwrites[userIdx].allow || '0')) | VIEW_CHANNEL | CONNECT | SPEAK);
  overwrites[userIdx].deny  = String((BigInt(overwrites[userIdx].deny  || '0')) & ~(VIEW_CHANNEL | CONNECT | SPEAK));
  console.log(`    updated existing user overwrite — allow=${overwrites[userIdx].allow}`);
} else {
  overwrites.push({ id: ALLOWED_USER, type: 1, allow: allowMask, deny: '0' });
  console.log(`    inserted new user overwrite — allow=${allowMask}`);
}
await api(KITSUNE_BOT, 'PATCH', `/channels/${KITSUNE_CHANNEL}`, { permission_overwrites: overwrites });
console.log('    patched.');

// --- 3. Twatwaffle two-button signup panel ------------------------------
console.log('\n[3/3] Twatwaffle signup panel…');

// 3a. Disable self_promo_config
console.log('  - Disabling self_promo_config (URL-parser pipeline)');
await pool.execute(
  'UPDATE self_promo_config SET enabled = 0, auto_subscribe = 0 WHERE guild_id = ?',
  [TWAT_GUILD]
);

// 3b. Find or create roles
console.log('  - Locating/creating Streamer + Auto-Add roles');
const twatRoles = await api(TWAT_BOT, 'GET', `/guilds/${TWAT_GUILD}/roles`);

async function ensureRole(name, color, mentionable) {
  let role = twatRoles.find(r => r.name === name);
  if (role) { console.log(`    reused role ${role.id} (${name})`); return role.id; }
  role = await api(TWAT_BOT, 'POST', `/guilds/${TWAT_GUILD}/roles`, {
    name, color, hoist: false, mentionable, permissions: '0',
  });
  console.log(`    created role ${role.id} (${name})`);
  return role.id;
}
const STREAMER_ROLE = await ensureRole('Streamer', 0x9146FF, true);  // pingable status
const AUTO_ADD_ROLE = await ensureRole('Auto-Add', 0x4E2A8E, false); // gated

// 3c. Ensure reaction_role_panels row points at the existing message
console.log('  - Upserting reaction_role_panels row');
const [existingPanel] = await pool.execute(
  'SELECT id FROM reaction_role_panels WHERE guild_id=? AND channel_id=? AND message_id=?',
  [TWAT_GUILD, TWAT_SIGNUP, TWAT_MSG]
);
let panelId;
if (existingPanel.length) {
  panelId = existingPanel[0].id;
  await pool.execute(
    `UPDATE reaction_role_panels
       SET panel_name=?, description=?, embed_color=?, panel_mode='standard', interaction_type='button'
     WHERE id=?`,
    ['Streaming Opt-In', 'Pingable streamer status + level-3 auto-add to live announcements.', '#9146FF', panelId]
  );
  console.log(`    reused panel id=${panelId}`);
} else {
  const [ins] = await pool.execute(
    `INSERT INTO reaction_role_panels
       (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type)
     VALUES (?, ?, ?, ?, ?, ?, 'standard', 'button')`,
    [TWAT_GUILD, TWAT_SIGNUP, TWAT_MSG, 'Streaming Opt-In', 'Pingable streamer status + level-3 auto-add to live announcements.', '#9146FF']
  );
  panelId = ins.insertId;
  console.log(`    inserted panel id=${panelId}`);
}

// 3d. Mappings
console.log('  - Upserting mappings');
async function upsertMapping(roleId, emoji, label, style, minLevel) {
  const [existing] = await pool.execute(
    'SELECT id FROM reaction_role_mappings WHERE panel_id=? AND role_id=?',
    [panelId, roleId]
  );
  if (existing.length) {
    await pool.execute(
      'UPDATE reaction_role_mappings SET emoji_id=?, label=?, button_style=?, min_level=? WHERE id=?',
      [emoji, label, style, minLevel, existing[0].id]
    );
    console.log(`      updated mapping ${existing[0].id} (${label})`);
  } else {
    await pool.execute(
      `INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [panelId, emoji, label, style, roleId, minLevel]
    );
    console.log(`      inserted mapping (${label}, min_level=${minLevel ?? 'NULL'})`);
  }
}
await upsertMapping(STREAMER_ROLE, '📣', 'Streamer (Ping Me)', 'secondary', null);
await upsertMapping(AUTO_ADD_ROLE, '🎙️', 'Auto-Add (Level 3+)', 'primary', TWAT_MIN_LEVEL);

// 3e. PATCH the existing message
console.log(`  - Patching message ${TWAT_MSG} with new embed + 2 buttons`);
const newEmbed = {
  type: 'rich',
  title: '📡 Streaming Opt-In',
  description: [
    `**How this works** — two buttons below.\n`,
    `**📣 Streamer (Ping Me)** — open self-assign. Grab the **Streamer** role any time you want to be pingable as a streamer. No level required, no auto-announcements.`,
    ``,
    `**🎙️ Auto-Add (Level 3+)** — opt into automatic live announcements in <#${TWAT_OUTPUT}>.`,
    `Reach **level ${TWAT_MIN_LEVEL}** first; you'll automatically get the **Shoutout Eligible** role at that threshold. Then click the button to receive the **Auto-Add** role and join the auto-announce rotation.`,
    `(Twitch streams only for now.)\n`,
    `**Notes**`,
    `• If your level drops below ${TWAT_MIN_LEVEL} after an XP reset, the gate blocks new opt-ins but your existing Auto-Add role isn't auto-revoked.`,
    `• Click the same button again to remove the role at any time.`,
    `• No URL-drop flow here anymore — buttons only.`,
  ].join('\n'),
  color: 0x9146FF,
};
const buttons = [{
  type: 1,
  components: [
    { type: 2, style: 2, label: 'Streamer (Ping Me)',  emoji: { name: '📣' }, custom_id: `rr_${STREAMER_ROLE}` },
    { type: 2, style: 1, label: 'Auto-Add (Level 3+)', emoji: { name: '🎙️' }, custom_id: `rr_${AUTO_ADD_ROLE}` },
  ],
}];
await api(TWAT_BOT, 'PATCH', `/channels/${TWAT_SIGNUP}/messages/${TWAT_MSG}`, {
  content: '',
  embeds: [newEmbed],
  components: buttons,
});
console.log('    patched.');

// 3f. guild_streamer_auto_track row
console.log('  - Upserting guild_streamer_auto_track (Auto-Add → output channel)');
const [existingTrack] = await pool.execute(
  'SELECT auto_id FROM guild_streamer_auto_track WHERE guild_id=? AND role_id=?',
  [TWAT_GUILD, AUTO_ADD_ROLE]
);
if (existingTrack.length) {
  await pool.execute(
    'UPDATE guild_streamer_auto_track SET announcement_channel_id=?, edit_on_end=1, delete_on_end=0, enabled=1 WHERE auto_id=?',
    [TWAT_OUTPUT, existingTrack[0].auto_id]
  );
  console.log(`    updated auto_id=${existingTrack[0].auto_id}`);
} else {
  await pool.execute(
    `INSERT INTO guild_streamer_auto_track
       (guild_id, role_id, announcement_channel_id, edit_on_end, delete_on_end, enabled)
     VALUES (?, ?, ?, 1, 0, 1)`,
    [TWAT_GUILD, AUTO_ADD_ROLE, TWAT_OUTPUT]
  );
  console.log('    inserted new auto-track row');
}

// --- Summary -----------------------------------------------------------
console.log('\n=== Summary ===');
console.log(`Kitsune (${KITSUNE_GUILD}):`);
console.log(`  voice channel ${KITSUNE_CHANNEL} ("${kch.name}") guarded — only user ${ALLOWED_USER} can stay`);
console.log(`Twatwaffle (${TWAT_GUILD}):`);
console.log(`  self_promo_config disabled`);
console.log(`  panel id=${panelId} on message ${TWAT_MSG}`);
console.log(`  📣 Streamer (Ping Me)        → role ${STREAMER_ROLE}, no gate`);
console.log(`  🎙️  Auto-Add (Level 3+)       → role ${AUTO_ADD_ROLE}, min_level=${TWAT_MIN_LEVEL}`);
console.log(`  guild_streamer_auto_track    → ${AUTO_ADD_ROLE} → #${TWAT_OUTPUT}`);
console.log(`  Shoutout Eligible (${SHOUTOUT_ELIGIBLE_ROLE}) — already at level ${TWAT_MIN_LEVEL} in level_role_rewards`);

await pool.end();
console.log('\nDone. Restart PM2 to pick up the voiceStateUpdate guard logic.');
