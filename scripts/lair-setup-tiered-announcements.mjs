// Mama Bear's Lair — tiered stream announcements + reset interval seeder.
//
// Wires:
//   - Self-promo tier (level 1+) signup channel → output channel
//   - Auto-track tier (level 2+) opt-in panel + auto_track row → output channel
//   - mamabear_xal dedicated channel + custom message, @everyone-on-end fix
//   - Per-guild 90-day reset interval
//
// REST-only — does not open a gateway, safe to run while PM2 is up.

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1216126780767731722';
const BOT_ID   = '1496406792417185802';

// Roles
const TWITCH_STREAMER_ROLE = '1414792796912746576'; // granted to level-2 opt-ins
const CUBS_ROLE            = '1496409522120560663'; // level-1 reward

// Channels
const SIGNUP_CH    = '1496410188737937561'; // self-promo URL drops + auto-live opt-in panel
const SELF_ANN_CH  = '1457541374424387768'; // self-promo announcements (level 1+)
const AUTO_ANN_CH  = '1457540221452423271'; // auto-track announcements (level 2+)
const MAMABEAR_CH  = '1457561921585942588'; // dedicated mamabear_xal channel

// Streamer
const MAMABEAR_USERNAME = 'mamabear_xal';
const MAMABEAR_PLATFORM = 'twitch';
const MAMABEAR_LIVE_MSG = `@everyone ${MAMABEAR_USERNAME} is now live!`;

// Reset
const RESET_INTERVAL_DAYS = 90;

// Panel
const PANEL_NAME        = '🎙️ Auto-Live Opt-In';
const PANEL_DESCRIPTION = `Level 2+ streamers can opt into automatic live announcements in <#${AUTO_ANN_CH}>. We'll post your Twitch stream automatically when you go live.`;
const PANEL_EMBED_COLOR = '#9146FF'; // Twitch purple
const MIN_LEVEL         = 2;
const BUTTON_LABEL      = 'Auto-Live (Level 2+)';
const BUTTON_EMOJI      = '🎙️';
const BUTTON_STYLE      = 'primary';

const [tokenRow] = await pool.execute(
  'SELECT bot_token FROM custom_bots WHERE bot_id=?',
  [BOT_ID]
);
if (!tokenRow.length) {
  console.error('FATAL: no custom_bots row for bot_id=' + BOT_ID);
  await pool.end();
  process.exit(1);
}
const token = encryption.decrypt(JSON.parse(tokenRow[0].bot_token));

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path} → ${r.status}: ${text}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

console.log('=== Mama Bear\'s Lair tiered announcements seeder ===\n');

// --- 1. self_promo_config: flip channels + clear role requirement ----------
console.log('[1/5] self_promo_config — channel_id=signup, announcement_channel_id=self-tier output');
await pool.execute(
  `INSERT INTO self_promo_config (
     guild_id, enabled, channel_id, same_channel, announcement_channel_id,
     announce_gate_enabled, announce_min_level, announce_required_role_ids,
     announce_delete_unauthorized, auto_subscribe, delete_invalid,
     dm_on_track, dm_on_already_tracked,
     allowed_platforms, whitelisted_role_ids
   ) VALUES (?, 1, ?, 0, ?, 1, 1, ?, 1, 1, 1, 1, 1, ?, ?)
   ON DUPLICATE KEY UPDATE
     enabled = 1,
     channel_id = VALUES(channel_id),
     same_channel = 0,
     announcement_channel_id = VALUES(announcement_channel_id),
     announce_gate_enabled = 1,
     announce_min_level = 1,
     announce_required_role_ids = VALUES(announce_required_role_ids),
     announce_delete_unauthorized = 1,
     auto_subscribe = 1,
     delete_invalid = 1,
     dm_on_track = 1,
     dm_on_already_tracked = 1`,
  [
    GUILD_ID,
    SIGNUP_CH,
    SELF_ANN_CH,
    JSON.stringify([]), // no role required — level 1 is the gate
    JSON.stringify(['twitch', 'kick', 'youtube', 'tiktok', 'trovo', 'facebook']),
    JSON.stringify([CUBS_ROLE, TWITCH_STREAMER_ROLE]),
  ]
);
console.log(`       channel_id=${SIGNUP_CH} announcement_channel_id=${SELF_ANN_CH} min_level=1\n`);

// --- 2. guild_streamer_auto_track ----------------------------------------
console.log('[2/5] guild_streamer_auto_track — Twitch Streamer role → auto-tier output');
await pool.execute(
  `INSERT INTO guild_streamer_auto_track
     (guild_id, role_id, announcement_channel_id, edit_on_end, delete_on_end, enabled)
   VALUES (?, ?, ?, 1, 0, 1)
   ON DUPLICATE KEY UPDATE
     announcement_channel_id = VALUES(announcement_channel_id),
     edit_on_end = 1,
     delete_on_end = 0,
     enabled = 1`,
  [GUILD_ID, TWITCH_STREAMER_ROLE, AUTO_ANN_CH]
);
console.log(`       role_id=${TWITCH_STREAMER_ROLE} announcement_channel_id=${AUTO_ANN_CH}\n`);

// --- 3. mamabear_xal subscription ----------------------------------------
console.log('[3/5] mamabear_xal subscription — dedicated channel + custom message');
const [streamerRows] = await pool.execute(
  'SELECT streamer_id FROM streamers WHERE platform=? AND username=? LIMIT 1',
  [MAMABEAR_PLATFORM, MAMABEAR_USERNAME]
);
const mamabearStreamerId = streamerRows[0]?.streamer_id;
if (!mamabearStreamerId) {
  console.error('FATAL: no streamers row for mamabear_xal — orchestrator does not auto-create top-level streamers');
  await pool.end();
  process.exit(1);
}
// COALESCE preserves existing custom_message if present
await pool.execute(
  `UPDATE subscriptions
     SET announcement_channel_id = ?,
         custom_message = COALESCE(NULLIF(custom_message, ''), ?),
         edit_on_end = 1,
         delete_on_end = 0,
         paused = 0
   WHERE guild_id = ? AND streamer_id = ?`,
  [MAMABEAR_CH, MAMABEAR_LIVE_MSG, GUILD_ID, mamabearStreamerId]
);
const [mamaCheck] = await pool.execute(
  'SELECT announcement_channel_id, custom_message, edit_on_end, delete_on_end FROM subscriptions WHERE guild_id=? AND streamer_id=?',
  [GUILD_ID, mamabearStreamerId]
);
console.log(`       ${JSON.stringify(mamaCheck[0])}\n`);

// --- 4. level_config: 90-day reset interval ------------------------------
console.log(`[4/5] level_config — reset_interval_days=${RESET_INTERVAL_DAYS}`);
await pool.execute(
  `INSERT INTO level_config (guild_id, enabled, monthly_reset_enabled, reset_interval_days)
   VALUES (?, 1, 1, ?)
   ON DUPLICATE KEY UPDATE
     monthly_reset_enabled = 1,
     reset_interval_days = VALUES(reset_interval_days)`,
  [GUILD_ID, RESET_INTERVAL_DAYS]
);
const [lcCheck] = await pool.execute(
  'SELECT monthly_reset_enabled, reset_interval_days, last_reset_at FROM level_config WHERE guild_id=?',
  [GUILD_ID]
);
console.log(`       ${JSON.stringify(lcCheck[0])}\n`);

// --- 5. Auto-Live opt-in panel ------------------------------------------
console.log('[5/5] Auto-Live opt-in panel — channel ' + SIGNUP_CH);
const [existingPanel] = await pool.execute(
  'SELECT id, message_id FROM reaction_role_panels WHERE guild_id=? AND channel_id=? AND panel_name=? LIMIT 1',
  [GUILD_ID, SIGNUP_CH, PANEL_NAME]
);

let panelId;
let panelMessageId;

const embedPayload = {
  title: PANEL_NAME,
  description: PANEL_DESCRIPTION,
  color: 0x9146FF,
};

const buttonComponents = [{
  type: 1, // ACTION_ROW
  components: [{
    type: 2, // BUTTON
    style: 1, // PRIMARY
    label: BUTTON_LABEL,
    emoji: { name: BUTTON_EMOJI },
    custom_id: `rr_${TWITCH_STREAMER_ROLE}`,
  }],
}];

if (existingPanel.length) {
  panelId = existingPanel[0].id;
  panelMessageId = existingPanel[0].message_id;
  console.log(`       panel exists (id=${panelId}, msg=${panelMessageId}) — patching message`);
  await api('PATCH', `/channels/${SIGNUP_CH}/messages/${panelMessageId}`, {
    embeds: [embedPayload],
    components: buttonComponents,
  });
} else {
  // Insert panel row first so we have a numeric id; message_id filled in after POST.
  const [insertPanelRes] = await pool.execute(
    `INSERT INTO reaction_role_panels
       (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type)
     VALUES (?, ?, '', ?, ?, ?, 'standard', 'button')`,
    [GUILD_ID, SIGNUP_CH, PANEL_NAME, PANEL_DESCRIPTION, PANEL_EMBED_COLOR]
  );
  panelId = insertPanelRes.insertId;
  console.log(`       inserted panel row id=${panelId}, posting Discord message…`);

  const posted = await api('POST', `/channels/${SIGNUP_CH}/messages`, {
    embeds: [embedPayload],
    components: buttonComponents,
  });
  panelMessageId = posted.id;

  await pool.execute(
    'UPDATE reaction_role_panels SET message_id=? WHERE id=?',
    [panelMessageId, panelId]
  );
  console.log(`       posted message_id=${panelMessageId}, panel row updated`);
}

// Upsert the mapping (panel_id, role_id) with min_level=2
const [existingMapping] = await pool.execute(
  'SELECT id FROM reaction_role_mappings WHERE panel_id=? AND role_id=?',
  [panelId, TWITCH_STREAMER_ROLE]
);
if (existingMapping.length) {
  await pool.execute(
    'UPDATE reaction_role_mappings SET emoji_id=?, label=?, button_style=?, min_level=? WHERE id=?',
    [BUTTON_EMOJI, BUTTON_LABEL, BUTTON_STYLE, MIN_LEVEL, existingMapping[0].id]
  );
  console.log(`       mapping updated (id=${existingMapping[0].id}, min_level=${MIN_LEVEL})`);
} else {
  await pool.execute(
    `INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [panelId, BUTTON_EMOJI, BUTTON_LABEL, BUTTON_STYLE, TWITCH_STREAMER_ROLE, MIN_LEVEL]
  );
  console.log(`       mapping inserted (min_level=${MIN_LEVEL})`);
}

console.log('\n=== Summary ===');
console.log(`Signup channel:           #${SIGNUP_CH}`);
console.log(`Self-promo (level 1+) →   #${SELF_ANN_CH}`);
console.log(`Auto-track (level 2+) →   #${AUTO_ANN_CH}`);
console.log(`mamabear_xal dedicated →  #${MAMABEAR_CH}`);
console.log(`Panel id ${panelId}, message id ${panelMessageId}`);
console.log(`Reset interval: ${RESET_INTERVAL_DAYS} days (monthly_reset_enabled=1)`);

await pool.end();
console.log('\nDone.');
