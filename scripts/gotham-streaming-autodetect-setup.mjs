// Gotham streaming auto-detection setup:
//   1. Create `Live Notify` role (color, mentionable, no perms)
//   2. Create `Streamer` role (so presenceUpdate.js's auto-assign at line 269 finds it)
//   3. Create #streamer-signup text channel under the Welcome category, locked
//      so @everyone can see/read but not send
//   4. Post a 2-button panel message
//   5. Insert reaction_role_panels + mappings
//   6. Insert guild_streamer_auto_track row (role_id=NULL → auto-detect any
//      member who goes live, live_role_id=LiveNotify → ping that role)
//
// REST-only. Default bot serves this guild — no custom bot involved.

import 'dotenv/config';
import pool from '../utils/db.js';

const GUILD = '800157336458231848';
const WELCOME_CATEGORY = '1070157474331623484';
const ANNOUNCE_CH = '1038268111029280778';  // #bats-reccomendations
const EVERYONE = GUILD;

const token = process.env.DISCORD_TOKEN;
async function api(method, path, body) {
  await new Promise(r => setTimeout(r, 60));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 200));
    return api(method, path, body);
  }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${(await r.text()).slice(0, 250)}`);
  return r.status === 204 ? null : r.json();
}

console.log('=== Gotham streaming auto-detect ===\n');

// --- 1. Roles ----------------------------------------------------------
console.log('[1] Locating/creating roles…');
const allRoles = await api('GET', `/guilds/${GUILD}/roles`);

async function ensureRole(name, color, mentionable, hoist = false) {
  let r = allRoles.find(x => x.name === name && !x.managed);
  if (r) { console.log(`    reused ${r.id} "${name}"`); return r.id; }
  r = await api('POST', `/guilds/${GUILD}/roles`, {
    name, color, hoist, mentionable, permissions: '0',
  });
  console.log(`    created ${r.id} "${name}"`);
  return r.id;
}
const STREAMER_ROLE = await ensureRole('Streamer', 0x9146FF, true);
const LIVE_NOTIFY_ROLE = await ensureRole('Live Notify', 0xFF6B6B, true);

// --- 2. Channel --------------------------------------------------------
console.log('\n[2] Locating/creating #streamer-signup…');
const channels = await api('GET', `/guilds/${GUILD}/channels`);
let signupCh = channels.find(c => c.name === 'streamer-signup' && c.type === 0);
if (signupCh) {
  console.log(`    reused ${signupCh.id} "${signupCh.name}"`);
} else {
  signupCh = await api('POST', `/guilds/${GUILD}/channels`, {
    name: 'streamer-signup',
    type: 0,
    parent_id: WELCOME_CATEGORY,
    topic: 'Click below to be pinged when streams go live, or to self-assign the Streamer role.',
    permission_overwrites: [
      { id: EVERYONE, type: 0, allow: '1024', deny: '2048' }, // VIEW yes, SEND no
    ],
  });
  console.log(`    created ${signupCh.id} #${signupCh.name}`);
}
const SIGNUP_CH = signupCh.id;

// --- 3. Panel message --------------------------------------------------
console.log('\n[3] Posting/patching the panel message…');
const newEmbed = {
  type: 'rich',
  title: '🎙️ Stream Notifications & Streamer Roles',
  description: [
    `**Auto-detection is on.** Link your Twitch account to your Discord profile (User Settings → Connections → Twitch), then go live — the bot picks you up automatically and posts your stream in <#${ANNOUNCE_CH}>. No registration, no commands, no URL drop.`,
    ``,
    `**📣 Streamer (Ping Me)** — open self-assign. Grab the role if you stream. The bot also auto-grants it the first time it sees you live.`,
    ``,
    `**🔔 Live Notify** — click to be **pinged** every time a stream goes live in <#${ANNOUNCE_CH}>. Click again to stop receiving pings.`,
    ``,
    `**Verify** what the bot is tracking for you anywhere: \`/socials streamer list\`.`,
    ``,
    `*This replaces the old Streamcord / NotifyMe / Sx Bot / Twitch Alerts setup — one bot, one channel, one ping role.*`,
  ].join('\n'),
  color: 0x9146FF,
};
const buttons = [{
  type: 1,
  components: [
    { type: 2, style: 2, label: 'Streamer (Ping Me)', emoji: { name: '📣' }, custom_id: `rr_${STREAMER_ROLE}` },
    { type: 2, style: 1, label: 'Live Notify',         emoji: { name: '🔔' }, custom_id: `rr_${LIVE_NOTIFY_ROLE}` },
  ],
}];

// Find existing panel message owned by us, if any
const existing = await api('GET', `/channels/${SIGNUP_CH}/messages?limit=20`);
let panelMsg = existing.find(m => m.embeds?.[0]?.title?.includes('Stream Notifications') && m.author?.bot);
if (panelMsg) {
  await api('PATCH', `/channels/${SIGNUP_CH}/messages/${panelMsg.id}`, { content: '', embeds: [newEmbed], components: buttons });
  console.log(`    patched existing message ${panelMsg.id}`);
} else {
  panelMsg = await api('POST', `/channels/${SIGNUP_CH}/messages`, { embeds: [newEmbed], components: buttons });
  console.log(`    posted new message ${panelMsg.id}`);
}
const PANEL_MSG = panelMsg.id;

// --- 4. DB rows --------------------------------------------------------
console.log('\n[4] Inserting reaction_role_panels + mappings…');
const [existingPanel] = await pool.execute(
  'SELECT id FROM reaction_role_panels WHERE guild_id=? AND channel_id=? AND message_id=?',
  [GUILD, SIGNUP_CH, PANEL_MSG]
);
let panelId;
if (existingPanel.length) {
  panelId = existingPanel[0].id;
  console.log(`    reused panel id=${panelId}`);
} else {
  const [ins] = await pool.execute(
    `INSERT INTO reaction_role_panels
       (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type)
     VALUES (?, ?, ?, 'Streaming Auto-Detect', 'Streamer self-assign + Live Notify ping opt-in', '#9146FF', 'standard', 'button')`,
    [GUILD, SIGNUP_CH, PANEL_MSG]
  );
  panelId = ins.insertId;
  console.log(`    inserted panel id=${panelId}`);
}

async function upsertMapping(roleId, emoji, label, style) {
  const [existing] = await pool.execute(
    'SELECT id FROM reaction_role_mappings WHERE panel_id=? AND role_id=?',
    [panelId, roleId]
  );
  if (existing.length) {
    await pool.execute(
      'UPDATE reaction_role_mappings SET emoji_id=?, label=?, button_style=?, min_level=NULL WHERE id=?',
      [emoji, label, style, existing[0].id]
    );
    console.log(`      updated mapping ${existing[0].id} (${label})`);
  } else {
    await pool.execute(
      `INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [panelId, emoji, label, style, roleId]
    );
    console.log(`      inserted mapping (${label})`);
  }
}
await upsertMapping(STREAMER_ROLE,    '📣', 'Streamer (Ping Me)', 'secondary');
await upsertMapping(LIVE_NOTIFY_ROLE, '🔔', 'Live Notify',         'primary');

// --- 5. guild_streamer_auto_track --------------------------------------
console.log('\n[5] Inserting guild_streamer_auto_track…');
// role_id NULL = auto-detect anyone with linked Twitch who goes live
const [existingTrack] = await pool.execute(
  'SELECT auto_id FROM guild_streamer_auto_track WHERE guild_id = ?',
  [GUILD]
);
if (existingTrack.length) {
  await pool.execute(
    'UPDATE guild_streamer_auto_track SET role_id=NULL, announcement_channel_id=?, live_role_id=?, edit_on_end=1, delete_on_end=0, enabled=1 WHERE auto_id=?',
    [ANNOUNCE_CH, LIVE_NOTIFY_ROLE, existingTrack[0].auto_id]
  );
  console.log(`    updated auto_id=${existingTrack[0].auto_id}`);
} else {
  await pool.execute(
    `INSERT INTO guild_streamer_auto_track
       (guild_id, role_id, announcement_channel_id, live_role_id, edit_on_end, delete_on_end, enabled)
     VALUES (?, NULL, ?, ?, 1, 0, 1)`,
    [GUILD, ANNOUNCE_CH, LIVE_NOTIFY_ROLE]
  );
  console.log('    inserted new auto-track row');
}

console.log('\n=== Summary ===');
console.log(`Streamer role:          ${STREAMER_ROLE}`);
console.log(`Live Notify role:       ${LIVE_NOTIFY_ROLE}  (pinged on every live announcement)`);
console.log(`#streamer-signup:       ${SIGNUP_CH}`);
console.log(`Panel id:               ${panelId} (message ${PANEL_MSG})`);
console.log(`Auto-track row:         role_id=NULL (open detection) → #${ANNOUNCE_CH}`);
console.log('\nMembers linked-Twitch-to-Discord going live will now auto-subscribe.');
console.log('Existing subscriptions (tikiroombunnies, justfourcats) are untouched.');

await pool.end();
