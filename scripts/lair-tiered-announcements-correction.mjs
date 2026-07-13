// Correction pass after the initial tiered-announcements seed:
//   - Level-1 channel is for MANUAL self-promo (no bot URL parsing, no auto-sub).
//   - Level-2 is the gate for the AUTOMATED tier only.
//
// Actions:
//   1. Disable self_promo_config for Lair (turn off the URL-parser pipeline).
//   2. Lock #1457540221452423271 — @everyone deny SEND (bot posts only).
//      (#1457541374424387768 perms already correct: Cubs allows SEND.)
//   3. Rewrite message 1496432752738701372 with the corrected tiered
//      explanation AND attach the Auto-Live button to it.
//   4. Re-point reaction_role_panels.message_id to the rewritten message.
//   5. Delete the orphan message I posted earlier (1503606660609081354).
//
// REST-only — safe alongside live PM2.

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID    = '1216126780767731722';
const BOT_ID      = '1496406792417185802';
const EVERYONE_ID = GUILD_ID; // @everyone role id == guild id

const TWITCH_STREAMER_ROLE = '1414792796912746576';
const CUBS_ROLE            = '1496409522120560663';

const SIGNUP_CH     = '1496410188737937561';
const SELF_ANN_CH   = '1457541374424387768';
const AUTO_ANN_CH   = '1457540221452423271';
const MAMABEAR_CH   = '1457561921585942588';

const NEW_INSTRUCTION_MSG = '1496432752738701372';
const ORPHAN_MSG          = '1503606660609081354';
const PANEL_ID            = 140;

const VIEW_CHANNEL  = 1024n;
const SEND_MESSAGES = 2048n;

const [tokenRow] = await pool.execute(
  'SELECT bot_token FROM custom_bots WHERE bot_id=?',
  [BOT_ID]
);
const token = encryption.decrypt(JSON.parse(tokenRow[0].bot_token));

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path} → ${r.status}: ${text}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

console.log('=== Lair tiered announcements — correction pass ===\n');

// --- 1. Disable self_promo_config -----------------------------------------
console.log('[1/5] self_promo_config — disabling URL-parser pipeline');
await pool.execute(
  'UPDATE self_promo_config SET enabled = 0, auto_subscribe = 0 WHERE guild_id = ?',
  [GUILD_ID]
);
console.log('       enabled=0, auto_subscribe=0\n');

// --- 2. Lock auto-tier channel SEND --------------------------------------
console.log(`[2/5] ${AUTO_ANN_CH} (auto-tier) — adding @everyone deny SEND`);
const autoCh = await api('GET', `/channels/${AUTO_ANN_CH}`);
const overwrites = (autoCh.permission_overwrites || []).map(o => ({
  id: o.id, type: o.type, allow: o.allow, deny: o.deny,
}));
const everyoneIdx = overwrites.findIndex(o => o.id === EVERYONE_ID);
if (everyoneIdx >= 0) {
  const existingDeny = BigInt(overwrites[everyoneIdx].deny || '0');
  const newDeny = existingDeny | SEND_MESSAGES;
  if (existingDeny !== newDeny) {
    overwrites[everyoneIdx].deny = String(newDeny);
    console.log(`       @everyone deny: ${existingDeny} → ${newDeny}`);
  } else {
    console.log('       @everyone already denies SEND, nothing to change');
  }
} else {
  overwrites.push({
    id: EVERYONE_ID, type: 0,
    allow: '0', deny: String(VIEW_CHANNEL | SEND_MESSAGES),
  });
  console.log('       inserted new @everyone overwrite (deny VIEW + SEND)');
}
await api('PATCH', `/channels/${AUTO_ANN_CH}`, {
  permission_overwrites: overwrites,
});
console.log('       patched.\n');

// --- 3. Rewrite the instructional message + attach Auto-Live button ------
console.log(`[3/5] Rewriting message ${NEW_INSTRUCTION_MSG} in #${SIGNUP_CH}`);

const newEmbed = {
  type: 'rich',
  title: '📡 How Streaming Works in the Lair',
  description: [
    `Two tiers — manual at level 1, automated at level 2.\n`,
    `**Tier 1 — Self-Promo (Level 1+)**`,
    `Once you reach **level 1** you get the **Cubs** role and unlock <#${SELF_ANN_CH}>.`,
    `Write your own stream announcement there. *The bot does not auto-track you at this tier.*`,
    `Multiple platforms allowed (Twitch, Kick, YouTube, etc.). One post per stream, please.\n`,
    `**Tier 2 — Auto-Live Announcements (Level 2+)**`,
    `Reach **level 2**, then click the **🎙️ Auto-Live (Level 2+)** button below.`,
    `The bot grants you the **Twitch Streamer** role and starts auto-announcing your Twitch streams in <#${AUTO_ANN_CH}>.`,
    `(Twitch only — manual self-promo in <#${SELF_ANN_CH}> stays available for everything else.)\n`,
    `**Notes**`,
    `• XP/levels reset every **90 days**; if you drop below level 2 the auto-tier pauses until you re-earn it`,
    `• If you go below level 1, you'll lose Cubs and the self-promo channel as well`,
    `• mamabear_xal's streams have their own dedicated channel: <#${MAMABEAR_CH}>`,
  ].join('\n'),
  color: 0x9146FF,
};

const buttonComponents = [{
  type: 1,
  components: [{
    type: 2,
    style: 1,
    label: 'Auto-Live (Level 2+)',
    emoji: { name: '🎙️' },
    custom_id: `rr_${TWITCH_STREAMER_ROLE}`,
  }],
}];

await api('PATCH', `/channels/${SIGNUP_CH}/messages/${NEW_INSTRUCTION_MSG}`, {
  embeds: [newEmbed],
  components: buttonComponents,
});
console.log('       patched.\n');

// --- 4. Re-point the reaction_role_panels row ----------------------------
console.log(`[4/5] reaction_role_panels.id=${PANEL_ID} — moving message_id pointer`);
await pool.execute(
  'UPDATE reaction_role_panels SET message_id = ? WHERE id = ?',
  [NEW_INSTRUCTION_MSG, PANEL_ID]
);
console.log(`       panel ${PANEL_ID} now points at message ${NEW_INSTRUCTION_MSG}\n`);

// --- 5. Delete the orphan message ----------------------------------------
console.log(`[5/5] Deleting orphan message ${ORPHAN_MSG}`);
try {
  await api('DELETE', `/channels/${SIGNUP_CH}/messages/${ORPHAN_MSG}`);
  console.log('       deleted.\n');
} catch (e) {
  console.log(`       could not delete (${e.message}) — manually remove if needed.\n`);
}

console.log('=== Summary ===');
console.log(`• self_promo_config disabled (bot no longer parses URLs in #${SIGNUP_CH})`);
console.log(`• #${AUTO_ANN_CH} now blocks manual posts (@everyone deny SEND)`);
console.log(`• Single instructional message ${NEW_INSTRUCTION_MSG} with the Auto-Live button`);
console.log(`• reaction_role_panels.id=${PANEL_ID} repointed to ${NEW_INSTRUCTION_MSG}`);
console.log(`• Orphan ${ORPHAN_MSG} removed`);

await pool.end();
console.log('\nDone.');
