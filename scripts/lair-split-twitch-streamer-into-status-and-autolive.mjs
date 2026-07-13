// Split Twitch Streamer into two distinct roles for Mama Bear's Lair:
//   - Twitch Streamer (existing, 1414792796912746576) — open self-assign
//     pingable/status role, no level gate.
//   - Auto-Live (NEW)                                 — gated at level 2,
//     used by guild_streamer_auto_track for auto-announcements.
//
// Steps:
//   1. Create new "Auto-Live" role in the guild (REST).
//   2. Update DB:
//      - reaction_role_mappings: existing TS row → min_level = NULL
//      - reaction_role_mappings: new TS+Auto-Live row → min_level = 2
//      - guild_streamer_auto_track: role_id → new Auto-Live role
//   3. Patch the signup-channel message: rewrite embed + 2-button row.
//   4. Grandfather pass: for every current Twitch Streamer holder, look up
//      their level; if >= 2, grant them the new Auto-Live role so their
//      existing auto-track behavior keeps working.
//
// REST-only — safe alongside live PM2.

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID  = '1216126780767731722';
const BOT_ID    = '1496406792417185802';
const PANEL_ID  = 140;
const SIGNUP_CH = '1496410188737937561';
const PANEL_MSG = '1496432752738701372';

const TWITCH_STREAMER_ROLE = '1414792796912746576';
const SELF_ANN_CH = '1457541374424387768';
const AUTO_ANN_CH = '1457540221452423271';
const MAMABEAR_CH = '1457561921585942588';

const NEW_ROLE_NAME  = 'Auto-Live';
const NEW_ROLE_COLOR = 0x9146FF;
const MIN_LEVEL      = 2;

const [tokenRow] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(tokenRow[0].bot_token));

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${await r.text()}`);
  if (r.status === 204) return null;
  return r.json();
}

console.log('=== Lair role split — Twitch Streamer (status) + Auto-Live (gated) ===\n');

// --- 1. Create or reuse Auto-Live role -----------------------------------
console.log('[1/5] Looking for existing Auto-Live role…');
const existingRoles = await api('GET', `/guilds/${GUILD_ID}/roles`);
let autoLiveRole = existingRoles.find(r => r.name === NEW_ROLE_NAME);
if (autoLiveRole) {
  console.log(`       reusing role ${autoLiveRole.id} (${autoLiveRole.name})`);
} else {
  console.log('       creating new role…');
  autoLiveRole = await api('POST', `/guilds/${GUILD_ID}/roles`, {
    name: NEW_ROLE_NAME,
    color: NEW_ROLE_COLOR,
    hoist: false,
    mentionable: false,
    permissions: '0',
  });
  console.log(`       created role ${autoLiveRole.id} (${autoLiveRole.name})`);
}
const AUTO_LIVE_ROLE = autoLiveRole.id;

// --- 2. Update DB --------------------------------------------------------
console.log('\n[2/5] Updating reaction_role_mappings…');
// existing Twitch Streamer mapping → ungated
const [tsMap] = await pool.execute(
  'SELECT id, min_level FROM reaction_role_mappings WHERE panel_id=? AND role_id=?',
  [PANEL_ID, TWITCH_STREAMER_ROLE]
);
if (tsMap.length) {
  await pool.execute(
    'UPDATE reaction_role_mappings SET min_level = NULL, emoji_id=?, label=? WHERE id=?',
    ['📣', 'Streamer (Ping Me)', tsMap[0].id]
  );
  console.log(`       Twitch Streamer mapping (id=${tsMap[0].id}) ungated, relabeled "Streamer (Ping Me)"`);
} else {
  await pool.execute(
    `INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level)
     VALUES (?, '📣', 'Streamer (Ping Me)', 'secondary', ?, NULL)`,
    [PANEL_ID, TWITCH_STREAMER_ROLE]
  );
  console.log('       inserted Twitch Streamer mapping (ungated)');
}

// new Auto-Live mapping → gated
const [alMap] = await pool.execute(
  'SELECT id FROM reaction_role_mappings WHERE panel_id=? AND role_id=?',
  [PANEL_ID, AUTO_LIVE_ROLE]
);
if (alMap.length) {
  await pool.execute(
    'UPDATE reaction_role_mappings SET min_level=?, emoji_id=?, label=?, button_style=? WHERE id=?',
    [MIN_LEVEL, '🎙️', 'Auto-Live (Level 2+)', 'primary', alMap[0].id]
  );
  console.log(`       Auto-Live mapping (id=${alMap[0].id}) updated`);
} else {
  await pool.execute(
    `INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level)
     VALUES (?, '🎙️', 'Auto-Live (Level 2+)', 'primary', ?, ?)`,
    [PANEL_ID, AUTO_LIVE_ROLE, MIN_LEVEL]
  );
  console.log('       inserted Auto-Live mapping (min_level=2)');
}

// guild_streamer_auto_track → new role
const [oldTrack] = await pool.execute(
  'SELECT auto_id FROM guild_streamer_auto_track WHERE guild_id=? AND role_id=?',
  [GUILD_ID, TWITCH_STREAMER_ROLE]
);
if (oldTrack.length) {
  await pool.execute(
    'UPDATE guild_streamer_auto_track SET role_id=? WHERE auto_id=?',
    [AUTO_LIVE_ROLE, oldTrack[0].auto_id]
  );
  console.log(`       guild_streamer_auto_track (auto_id=${oldTrack[0].auto_id}) repointed to Auto-Live`);
} else {
  await pool.execute(
    `INSERT INTO guild_streamer_auto_track
       (guild_id, role_id, announcement_channel_id, edit_on_end, delete_on_end, enabled)
     VALUES (?, ?, ?, 1, 0, 1)`,
    [GUILD_ID, AUTO_LIVE_ROLE, AUTO_ANN_CH]
  );
  console.log('       inserted new guild_streamer_auto_track row for Auto-Live');
}

// --- 3. Patch signup-channel message -------------------------------------
console.log('\n[3/5] Patching signup-panel message…');
const newEmbed = {
  type: 'rich',
  title: '📡 How Streaming Works in the Lair',
  description: [
    `Two tiers — manual at level 1, automated at level 2 — plus an open status role.\n`,
    `**Tier 1 — Self-Promo (Level 1+)**`,
    `Once you reach **level 1** you get the **Cubs** role and unlock <#${SELF_ANN_CH}>.`,
    `Write your own stream announcement there. *The bot does not auto-track you at this tier.*`,
    `Multiple platforms allowed (Twitch, Kick, YouTube, etc.). One post per stream, please.\n`,
    `**Tier 2 — Auto-Live Announcements (Level 2+)**`,
    `Reach **level 2**, then click **🎙️ Auto-Live (Level 2+)** below to receive the **Auto-Live** role.`,
    `The bot will auto-announce your Twitch streams in <#${AUTO_ANN_CH}>.`,
    `(Twitch only — manual self-promo in <#${SELF_ANN_CH}> stays available for everything else.)\n`,
    `**Pingable Streamer Status (anytime)**`,
    `Click **📣 Streamer (Ping Me)** to grab the **Twitch Streamer** role — purely a pingable/status tag, no level needed.`,
    `It does NOT enroll you in auto-announcements; that requires the Auto-Live role above.\n`,
    `**Notes**`,
    `• XP/levels reset every **90 days**. If you drop below level 2, your Auto-Live role won't be auto-revoked but you'll need to re-earn level 2 to re-opt-in via the button if you remove it.`,
    `• If you go below level 1, you lose Cubs and the self-promo channel access.`,
    `• mamabear_xal's streams have their own dedicated channel: <#${MAMABEAR_CH}>`,
  ].join('\n'),
  color: NEW_ROLE_COLOR,
};

const newComponents = [{
  type: 1,
  components: [
    {
      type: 2,
      style: 2, // secondary (gray)
      label: 'Streamer (Ping Me)',
      emoji: { name: '📣' },
      custom_id: `rr_${TWITCH_STREAMER_ROLE}`,
    },
    {
      type: 2,
      style: 1, // primary (blurple)
      label: 'Auto-Live (Level 2+)',
      emoji: { name: '🎙️' },
      custom_id: `rr_${AUTO_LIVE_ROLE}`,
    },
  ],
}];

await api('PATCH', `/channels/${SIGNUP_CH}/messages/${PANEL_MSG}`, {
  embeds: [newEmbed],
  components: newComponents,
});
console.log(`       patched message ${PANEL_MSG} with new embed + 2 buttons`);

// --- 4. Grandfather Twitch Streamer holders at level >= 2 ---------------
console.log('\n[4/5] Scanning Twitch Streamer holders for level-2+ grandfathering…');
let after = '0';
const tsHolders = [];
while (true) {
  const batch = await api('GET', `/guilds/${GUILD_ID}/members?limit=1000&after=${after}`);
  if (!Array.isArray(batch) || batch.length === 0) break;
  for (const m of batch) {
    if (m.roles?.includes(TWITCH_STREAMER_ROLE)) {
      tsHolders.push(m.user.id);
    }
  }
  if (batch.length < 1000) break;
  after = batch[batch.length - 1].user.id;
}
console.log(`       found ${tsHolders.length} Twitch Streamer holder(s)`);

if (tsHolders.length === 0) {
  console.log('       nothing to grandfather');
} else {
  const placeholders = tsHolders.map(() => '?').join(',');
  const [lvls] = await pool.execute(
    `SELECT user_id, level FROM user_levels WHERE guild_id = ? AND user_id IN (${placeholders})`,
    [GUILD_ID, ...tsHolders]
  );
  const levelByUser = new Map(lvls.map(r => [String(r.user_id), r.level]));

  const eligible = tsHolders.filter(uid => (levelByUser.get(uid) || 0) >= MIN_LEVEL);
  console.log(`       ${eligible.length} eligible (level >= ${MIN_LEVEL})`);

  let granted = 0, failed = 0;
  for (const uid of eligible) {
    try {
      await api('PUT', `/guilds/${GUILD_ID}/members/${uid}/roles/${AUTO_LIVE_ROLE}`);
      granted++;
    } catch (e) {
      failed++;
      console.log(`       ✗ ${uid}: ${e.message}`);
    }
  }
  console.log(`       granted Auto-Live to ${granted} member(s), ${failed} failure(s)`);

  const dropped = tsHolders.filter(uid => (levelByUser.get(uid) || 0) < MIN_LEVEL);
  console.log(`       ${dropped.length} below-level-${MIN_LEVEL} holders keep Twitch Streamer (status) only — they will NOT be auto-tracked anymore`);
}

// --- 5. Summary ----------------------------------------------------------
console.log('\n=== Summary ===');
console.log(`Auto-Live role id:                ${AUTO_LIVE_ROLE}`);
console.log(`Panel id ${PANEL_ID} now has 2 buttons:`);
console.log(`  📣 Streamer (Ping Me)         → Twitch Streamer (${TWITCH_STREAMER_ROLE}), no gate`);
console.log(`  🎙️  Auto-Live (Level 2+)       → Auto-Live (${AUTO_LIVE_ROLE}), min_level=${MIN_LEVEL}`);
console.log(`guild_streamer_auto_track:        role_id = Auto-Live → #${AUTO_ANN_CH}`);

await pool.end();
console.log('\nDone.');
