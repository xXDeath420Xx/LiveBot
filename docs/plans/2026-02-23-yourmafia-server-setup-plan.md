# YourMafia Discord Server Setup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create `setup-yourmafia-server.js` that sets up a complete Discord server for the YourMafia game — roles, channels, permissions, embeds, verification gate, and all bot DB configs.

**Architecture:** Single ESM script using Discord REST API v10 (same pattern as existing `setup-channels-roles.js` and `setup-server-security.js`). Creates everything from scratch on an empty server. The bot token is passed as a CLI argument or read from env. DB config uses the existing `pool` from `utils/db.js`.

**Tech Stack:** Node.js ESM, Discord REST API v10, mysql2 (via `utils/db.js`), `utils/encryption.js` for token storage in `custom_bots` table.

---

## Reference Files

- Pattern to follow: `setup-channels-roles.js` (Discord API helpers, channel/role creation)
- Pattern to follow: `setup-server-security.js` (DB config inserts for automod, anti-nuke, etc.)
- Custom bot registration: `dashboard/routes/super-admin.js:1009-1018`
- Encryption: `utils/encryption.js`
- DB connection: `utils/db.js`
- Command deploy: `scripts/deploy-commands-to-bot.js`

## Discord Permission Bit Values

```
VIEW_CHANNEL           = 1024        (1 << 10)
SEND_MESSAGES          = 2048        (1 << 11)
SEND_MESSAGES_IN_THREADS = 274877906944 (1 << 38)
EMBED_LINKS            = 16384       (1 << 14)
ATTACH_FILES           = 32768       (1 << 15)
ADD_REACTIONS          = 64          (1 << 6)
USE_EXTERNAL_EMOJIS    = 262144      (1 << 18)
READ_MESSAGE_HISTORY   = 65536       (1 << 16)
CONNECT                = 1048576     (1 << 20)
SPEAK                  = 2097152     (1 << 21)
MANAGE_MESSAGES        = 8192        (1 << 13)
MANAGE_CHANNELS        = 16          (1 << 4)
MANAGE_ROLES           = 268435456   (1 << 28)
KICK_MEMBERS           = 2           (1 << 1)
BAN_MEMBERS            = 4           (1 << 2)
MODERATE_MEMBERS       = 1099511627776 (1 << 40) — Timeout
MANAGE_SERVER          = 32          (1 << 5)
ADMINISTRATOR          = 8           (1 << 3)
```

Computed permission bundles:
- `BASIC_TEXT` = VIEW + SEND + READ_HISTORY + ADD_REACTIONS + EMBED + ATTACH + USE_EXTERNAL_EMOJIS = `1024 + 2048 + 65536 + 64 + 16384 + 32768 + 262144 = 379968`
- `READ_ONLY` = VIEW + READ_HISTORY = `1024 + 65536 = 66560`
- `DENY_ALL_TEXT` = SEND_MESSAGES + ADD_REACTIONS = `2048 + 64 = 2112`
- `BASIC_VOICE` = CONNECT + SPEAK = `1048576 + 2097152 = 3145728`

---

### Task 1: Script Skeleton + Discord API Helpers

**Files:**
- Create: `setup-yourmafia-server.js`

**Step 1: Create the script with imports, constants, and API helpers**

Copy the proven `fetchDiscord`, `createCategory`, `createChannel`, `createRole`, `setChannelPermissions` helpers from `setup-channels-roles.js`. Add the guild ID, bot token (from CLI arg or env), and the `created` storage object.

```js
/**
 * YourMafia Discord Server Setup
 * Guild ID: 1475352754682597468
 * Bot: Your Mafia (custom CertiFriedUtility instance)
 *
 * Creates all roles, categories, channels, permissions, embeds,
 * and bot DB configurations for the YourMafia game server.
 *
 * Usage: node setup-yourmafia-server.js [BOT_TOKEN]
 *   - If BOT_TOKEN arg provided, uses that
 *   - Otherwise reads YOURMAFIA_BOT_TOKEN from .env
 */
import dotenv from 'dotenv';
import pool from './utils/db.js';
import encryption from './utils/encryption.js';

dotenv.config();

const GUILD_ID = '1475352754682597468';
const BOT_TOKEN = process.argv[2] || process.env.YOURMAFIA_BOT_TOKEN;
const API_BASE = 'https://discord.com/api/v10';

if (!BOT_TOKEN) {
  console.error('❌ No bot token provided. Usage: node setup-yourmafia-server.js <BOT_TOKEN>');
  console.error('   Or set YOURMAFIA_BOT_TOKEN in .env');
  process.exit(1);
}

const created = {
  categories: {},
  channels: {},
  roles: {},
};

// --- Discord API helpers (from setup-channels-roles.js pattern) ---

async function fetchDiscord(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${API_BASE}${endpoint}`, options);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord API ${response.status}: ${error}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function createCategory(name, permissionOverwrites = []) {
  console.log(`   Creating category: ${name}`);
  return fetchDiscord(`/guilds/${GUILD_ID}/channels`, 'POST', {
    name,
    type: 4,
    permission_overwrites: permissionOverwrites,
  });
}

async function createChannel(name, type, parentId, topic = null, permissionOverwrites = []) {
  console.log(`   Creating channel: ${type === 2 ? '🔊' : '#'}${name}`);
  const data = { name, type, parent_id: parentId, permission_overwrites: permissionOverwrites };
  if (topic) data.topic = topic;
  return fetchDiscord(`/guilds/${GUILD_ID}/channels`, 'POST', data);
}

async function createRole(name, color, hoist = false, permissions = '0') {
  console.log(`   Creating role: @${name}`);
  return fetchDiscord(`/guilds/${GUILD_ID}/roles`, 'POST', {
    name, color, hoist, mentionable: false, permissions,
  });
}

async function setChannelPermissions(channelId, targetId, allow, deny = '0') {
  await fetchDiscord(`/channels/${channelId}/permissions/${targetId}`, 'PUT', {
    type: 0, allow: allow.toString(), deny: deny.toString(),
  });
}

async function sendChannelMessage(channelId, content) {
  return fetchDiscord(`/channels/${channelId}/messages`, 'POST', content);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

**Step 2: Verify the script runs without errors (no-op)**

Run: `node setup-yourmafia-server.js "TEST" 2>&1 | head -5`
Expected: No errors (script exits after helpers are defined since there's no `setup()` call yet)

**Step 3: Commit skeleton**

```bash
git add setup-yourmafia-server.js
git commit -m "feat: add YourMafia server setup script skeleton"
```

---

### Task 2: Role Creation

**Files:**
- Modify: `setup-yourmafia-server.js`

**Step 1: Add role definitions and creation logic**

Add role array and the `createRoles()` function after the helpers. Roles are created bottom-up (lowest first) because Discord positions roles from bottom. We'll reorder them after creation.

```js
// --- Role Definitions ---
// Created bottom-up, reordered after
const ROLES = [
  { key: 'quarantine',  name: 'Quarantine',    color: 0xE74C3C, hoist: false, permissions: '0' },
  { key: 'muted',       name: 'Muted',         color: 0x95A5A6, hoist: false, permissions: '0' },
  { key: 'verified',    name: 'Verified',       color: 0x3498DB, hoist: false, permissions: '0' },
  { key: 'og_player',   name: 'OG Player',     color: 0x9B59B6, hoist: true,  permissions: '0' },
  { key: 'vip',         name: 'VIP',           color: 0xF1C40F, hoist: true,  permissions: '0' },
  { key: 'trial_mod',   name: 'Trial Mod',     color: 0x27AE60, hoist: true,  permissions: (2048 + 8192 + 1099511627776).toString() },
  { key: 'moderator',   name: 'Moderator',     color: 0x2ECC71, hoist: true,  permissions: (2 + 2048 + 8192 + 1099511627776).toString() },
  { key: 'admin',       name: 'Admin',         color: 0xFF8C00, hoist: true,  permissions: (2 + 4 + 2048 + 8192).toString() },
  { key: 'head_admin',  name: 'Head Admin',    color: 0xFF4500, hoist: true,  permissions: (2 + 4 + 8192 + 268435456).toString() },
  { key: 'developer',   name: 'Developer',     color: 0xE91E63, hoist: true,  permissions: (16 + 32 + 268435456).toString() },
  { key: 'owner',       name: 'Owner',         color: 0xFF0000, hoist: true,  permissions: '8' },
];

async function createRoles() {
  console.log('📋 Creating Roles...');
  for (const roleDef of ROLES) {
    try {
      const role = await createRole(roleDef.name, roleDef.color, roleDef.hoist, roleDef.permissions);
      created.roles[roleDef.key] = role.id;
      console.log(`   ✅ @${roleDef.name} (${role.id})`);
      await sleep(300); // Rate limit safety
    } catch (e) {
      console.log(`   ⚠️ Failed @${roleDef.name}: ${e.message}`);
    }
  }

  // Reorder roles (highest position = highest authority)
  // Discord wants array of {id, position} — position 1 is just above @everyone
  console.log('   Reordering roles...');
  const rolePositions = ROLES.map((r, i) => ({
    id: created.roles[r.key],
    position: i + 1,
  })).filter(r => r.id);

  try {
    await fetchDiscord(`/guilds/${GUILD_ID}/roles`, 'PATCH', rolePositions);
    console.log('   ✅ Roles reordered');
  } catch (e) {
    console.log(`   ⚠️ Could not reorder roles: ${e.message}`);
  }
}
```

**Step 2: Commit**

```bash
git add setup-yourmafia-server.js
git commit -m "feat: add role creation to YourMafia setup"
```

---

### Task 3: Channel & Category Creation with Permissions

**Files:**
- Modify: `setup-yourmafia-server.js`

**Step 1: Add channel structure and creation logic**

Each category gets permission overwrites baked in at creation time. The verification gate works by:
- `@everyone` can only see VERIFICATION category
- `@Verified` can see everything else
- Staff categories restricted to staff roles

```js
// Permission bit constants
const P = {
  VIEW: '1024',
  SEND: '2048',
  READ_HISTORY: '65536',
  ADD_REACTIONS: '64',
  EMBED: '16384',
  ATTACH: '32768',
  EXT_EMOJI: '262144',
  MANAGE_MESSAGES: '8192',
  CONNECT: '1048576',
  SPEAK: '2097152',
};

const BASIC_TEXT = (1024 + 2048 + 65536 + 64 + 16384 + 32768 + 262144).toString();
const READ_ONLY = (1024 + 65536).toString();
const DENY_SEND = '2048';
const DENY_VIEW = '1024';
const DENY_ALL = (1024 + 2048).toString();
const BASIC_VOICE = (1048576 + 2097152).toString();

async function createChannels() {
  const r = created.roles;
  const botRoleOverwrite = (allow) => ({ id: r.bot || GUILD_ID, type: 0, allow, deny: '0' });

  // Helper: standard permission overwrites for category visibility
  function verifiedOnly() {
    return [
      { id: GUILD_ID, type: 0, allow: '0', deny: DENY_VIEW },           // @everyone: hidden
      { id: r.verified, type: 0, allow: READ_ONLY, deny: '0' },         // @Verified: visible
      { id: r.muted, type: 0, allow: P.VIEW, deny: DENY_SEND },         // @Muted: see but can't talk
    ].filter(o => o.id);
  }

  function staffOnly() {
    return [
      { id: GUILD_ID, type: 0, allow: '0', deny: DENY_VIEW },
      { id: r.trial_mod, type: 0, allow: READ_ONLY, deny: '0' },
      { id: r.moderator, type: 0, allow: BASIC_TEXT, deny: '0' },
      { id: r.admin, type: 0, allow: BASIC_TEXT, deny: '0' },
      { id: r.head_admin, type: 0, allow: BASIC_TEXT, deny: '0' },
      { id: r.developer, type: 0, allow: BASIC_TEXT, deny: '0' },
      { id: r.owner, type: 0, allow: BASIC_TEXT, deny: '0' },
    ].filter(o => o.id);
  }

  function readOnlyForVerified() {
    return [
      { id: GUILD_ID, type: 0, allow: '0', deny: DENY_VIEW },
      { id: r.verified, type: 0, allow: READ_ONLY, deny: DENY_SEND },
    ].filter(o => o.id);
  }

  // ── VERIFICATION CATEGORY (visible to everyone) ──
  console.log('\n📋 Creating VERIFICATION Category...');
  const verifCat = await createCategory('Verification', [
    { id: GUILD_ID, type: 0, allow: READ_ONLY, deny: DENY_SEND }, // everyone can see, not send
  ]);
  created.categories.verification = verifCat.id;

  const welcomeCh = await createChannel('welcome', 0, verifCat.id, 'Welcome to YourMafia!', [
    { id: GUILD_ID, type: 0, allow: READ_ONLY, deny: DENY_SEND },
  ]);
  created.channels.welcome = welcomeCh.id;

  const verifyCh = await createChannel('verify', 0, verifCat.id, 'Click the button below to verify and gain access to the server', [
    { id: GUILD_ID, type: 0, allow: READ_ONLY, deny: DENY_SEND },
  ]);
  created.channels.verify = verifyCh.id;

  // ── INFORMATION CATEGORY ──
  console.log('\n📋 Creating INFORMATION Category...');
  const infoCat = await createCategory('Information', readOnlyForVerified());
  created.categories.information = infoCat.id;

  for (const [key, name, topic] of [
    ['rules', 'rules', 'Server rules — read before participating'],
    ['announcements', 'announcements', 'Game updates and news'],
    ['patch_notes', 'patch-notes', 'YourMafia game changelog'],
    ['roles', 'roles', 'Pick your roles here'],
    ['faq', 'faq', 'Frequently asked questions'],
  ]) {
    const ch = await createChannel(name, 0, infoCat.id, topic, readOnlyForVerified());
    created.channels[key] = ch.id;
    await sleep(300);
  }

  // ── COMMUNITY CATEGORY ──
  console.log('\n📋 Creating COMMUNITY Category...');
  const commCat = await createCategory('Community', verifiedOnly());
  created.categories.community = commCat.id;

  for (const [key, name, topic] of [
    ['general', 'general', 'Main chat — talk about anything'],
    ['off_topic', 'off-topic', 'Non-game discussion'],
    ['media', 'media', 'Screenshots, videos, memes'],
    ['introductions', 'introductions', 'Introduce yourself to the community'],
  ]) {
    const ch = await createChannel(name, 0, commCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(300);
  }

  // ── YOURMAFIA GAME CATEGORY ──
  console.log('\n📋 Creating YOURMAFIA GAME Category...');
  const gameCat = await createCategory('YourMafia Game', verifiedOnly());
  created.categories.game = gameCat.id;

  for (const [key, name, topic] of [
    ['game_chat', 'game-chat', 'Discuss strategies, gangs, and crime'],
    ['gang_recruitment', 'gang-recruitment', 'Gangs recruiting members'],
    ['trading', 'trading', 'In-game item and credit trading'],
    ['game_events', 'game-events', 'Game event feeds (automated)'],
    ['leaderboards', 'leaderboards', 'Top players, gangs, and stats'],
  ]) {
    const ch = await createChannel(name, 0, gameCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(300);
  }

  // ── FEEDBACK CATEGORY ──
  console.log('\n📋 Creating FEEDBACK Category...');
  const feedbackCat = await createCategory('Feedback', verifiedOnly());
  created.categories.feedback = feedbackCat.id;

  for (const [key, name, topic] of [
    ['suggestions', 'suggestions', 'Submit and vote on suggestions'],
    ['bug_reports', 'bug-reports', 'Report game bugs here'],
    ['changelog', 'changelog', 'Staff responses to bugs and suggestions'],
  ]) {
    const ch = await createChannel(name, 0, feedbackCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(300);
  }

  // ── SUPPORT CATEGORY ──
  console.log('\n📋 Creating SUPPORT Category...');
  const supportCat = await createCategory('Support', verifiedOnly());
  created.categories.support = supportCat.id;

  const ticketCh = await createChannel('open-ticket', 0, supportCat.id, 'Click below to open a support ticket');
  created.channels.open_ticket = ticketCh.id;

  // ── VOICE CATEGORY ──
  console.log('\n📋 Creating VOICE Category...');
  const voiceCat = await createCategory('Voice', verifiedOnly());
  created.categories.voice = voiceCat.id;

  const generalVc = await createChannel('General Voice', 2, voiceCat.id);
  created.channels.general_voice = generalVc.id;

  const afkVc = await createChannel('AFK', 2, voiceCat.id);
  created.channels.afk = afkVc.id;

  // Set AFK channel for the guild
  try {
    await fetchDiscord(`/guilds/${GUILD_ID}`, 'PATCH', {
      afk_channel_id: afkVc.id,
      afk_timeout: 300, // 5 minutes
    });
    console.log('   ✅ AFK channel set (5 min timeout)');
  } catch (e) {
    console.log(`   ⚠️ Could not set AFK channel: ${e.message}`);
  }

  // ── STAFF AREA CATEGORY ──
  console.log('\n📋 Creating STAFF AREA Category...');
  const staffCat = await createCategory('Staff Area', staffOnly());
  created.categories.staff = staffCat.id;

  for (const [key, name, topic] of [
    ['staff_chat', 'staff-chat', 'Staff discussion'],
    ['mod_actions', 'mod-actions', 'Moderation action log'],
    ['staff_todos', 'staff-todos', 'Task tracking'],
    ['dev_chat', 'dev-chat', 'Developer discussion'],
    ['bot_testing', 'bot-testing', 'Bot command testing'],
  ]) {
    const ch = await createChannel(name, 0, staffCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(300);
  }

  // ── LOGS CATEGORY ──
  console.log('\n📋 Creating LOGS Category...');
  const logsCat = await createCategory('Logs', staffOnly());
  created.categories.logs = logsCat.id;

  for (const [key, name, topic] of [
    ['audit_log', 'audit-log', 'General server logs'],
    ['mod_logs', 'mod-logs', 'Moderation actions'],
    ['automod_logs', 'automod-logs', 'AutoMod triggers'],
    ['join_leave_log', 'join-leave-log', 'Member join/leave tracking'],
  ]) {
    const ch = await createChannel(name, 0, logsCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(300);
  }
}
```

**Step 2: Commit**

```bash
git add setup-yourmafia-server.js
git commit -m "feat: add channel/category creation with permissions"
```

---

### Task 4: Embed Messages (Rules, Verification Panel, FAQ)

**Files:**
- Modify: `setup-yourmafia-server.js`

**Step 1: Add functions to post embeds**

```js
async function postEmbeds() {
  console.log('\n📋 Posting Embeds...');

  // ── Rules Embed ──
  if (created.channels.rules) {
    await sendChannelMessage(created.channels.rules, {
      embeds: [{
        title: '📜 YourMafia Community Rules',
        description: [
          '**1. Respect All Members** — No harassment, hate speech, discrimination, or personal attacks.',
          '**2. No Spam** — No flooding, excessive caps, repeated messages, or meaningless content.',
          '**3. No Cheating Discussion** — Do not share exploits, hacks, or methods to cheat in YourMafia.',
          '**4. Keep It Legal** — No illegal content, doxxing, threats, or NSFW.',
          '**5. English Only** — Main channels are English. Use #off-topic for other languages.',
          '**6. No Advertising** — No unsolicited promotion of other games, servers, or services.',
          '**7. Use Channels Properly** — Keep discussions in their relevant channels.',
          '**8. Follow Discord ToS** — All Discord Terms of Service and Community Guidelines apply.',
          '**9. Listen to Staff** — Moderator decisions are final. Use <#' + (created.channels.open_ticket || '') + '> to appeal.',
          '**10. Have Fun** — This is a community. Enjoy the game and each other.',
        ].join('\n\n'),
        color: 0xFF4500,
        footer: { text: 'Violations result in progressive punishment: Warning → Mute → Kick → Ban' },
      }],
    });
    console.log('   ✅ Rules embed posted');
  }

  // ── Verification Embed (placeholder — bot's reaction role panel will replace) ──
  if (created.channels.verify) {
    await sendChannelMessage(created.channels.verify, {
      embeds: [{
        title: '🔓 Verify to Access YourMafia',
        description: [
          'Welcome to the **YourMafia** Discord server!',
          '',
          'To gain access to all channels, please read the rules in <#' + (created.channels.rules || '') + '> then use the `/panel deploy` command or the verification button below.',
          '',
          '> By verifying, you agree to follow our community rules.',
        ].join('\n'),
        color: 0x3498DB,
        footer: { text: 'Use /panel deploy to activate the verification button' },
      }],
    });
    console.log('   ✅ Verification embed posted');
  }

  // ── FAQ Embed ──
  if (created.channels.faq) {
    await sendChannelMessage(created.channels.faq, {
      embeds: [{
        title: '❓ Frequently Asked Questions',
        description: [
          '**Q: What is YourMafia?**',
          'A: YourMafia is a browser-based mafia MMORPG where you build your criminal empire through crime, gangs, trading, and more.',
          '',
          '**Q: How do I start playing?**',
          'A: Visit the game website, register an account, and start your criminal career!',
          '',
          '**Q: How do I report a bug?**',
          'A: Use <#' + (created.channels.bug_reports || '') + '> or open a ticket in <#' + (created.channels.open_ticket || '') + '>.',
          '',
          '**Q: How do I suggest a feature?**',
          'A: Use the `/engage suggest` command in <#' + (created.channels.suggestions || '') + '>.',
          '',
          '**Q: I got muted/banned unfairly!**',
          'A: Open a support ticket in <#' + (created.channels.open_ticket || '') + '> to appeal.',
          '',
          '**Q: Can I advertise my gang?**',
          'A: Yes! Use <#' + (created.channels.gang_recruitment || '') + '> for gang recruitment.',
        ].join('\n'),
        color: 0x5865F2,
      }],
    });
    console.log('   ✅ FAQ embed posted');
  }

  // ── Ticket Panel Embed ──
  if (created.channels.open_ticket) {
    await sendChannelMessage(created.channels.open_ticket, {
      embeds: [{
        title: '🎫 Support Tickets',
        description: [
          'Need help? Open a support ticket!',
          '',
          '**What tickets are for:**',
          '• Bug reports that need staff attention',
          '• Account issues',
          '• Ban/mute appeals',
          '• General questions for staff',
          '',
          '> Use the `/support ticket create` command to open a ticket.',
        ].join('\n'),
        color: 0x2ECC71,
        footer: { text: 'Staff will respond as soon as possible' },
      }],
    });
    console.log('   ✅ Ticket panel embed posted');
  }
}
```

**Step 2: Commit**

```bash
git add setup-yourmafia-server.js
git commit -m "feat: add embed messages for rules, verification, FAQ, tickets"
```

---

### Task 5: Database Configuration — Bot Features

**Files:**
- Modify: `setup-yourmafia-server.js`

**Step 1: Add DB config function**

This inserts/upserts rows into all the bot's config tables for this guild.

```js
async function configureBotDatabase() {
  const ch = created.channels;
  const r = created.roles;

  console.log('\n📋 Configuring Bot Database...');

  // ── 1. Logging Config ──
  await pool.execute(`
    INSERT INTO logging_config (guild_id, log_channel_id, enabled_events)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      log_channel_id = VALUES(log_channel_id),
      enabled_events = VALUES(enabled_events)
  `, [
    GUILD_ID,
    ch.audit_log,
    JSON.stringify([
      'messageDelete', 'messageUpdate', 'messageBulkDelete',
      'memberJoin', 'memberLeave', 'memberUpdate', 'memberKick', 'memberBan',
      'voiceUpdate',
      'channelCreate', 'channelDelete', 'channelUpdate',
      'guildUpdate',
      'ban', 'unban',
      'roleCreate', 'roleDelete', 'roleUpdate',
      'moderation', 'automod',
      'join-gate', 'system', 'xp',
      'tickets',
    ]),
  ]);
  console.log('   ✅ Logging config → #audit-log');

  // ── 2. Moderation Config ──
  await pool.execute(`
    INSERT INTO moderation_config (guild_id, enabled, mod_log_channel_id, mute_role_id, dm_on_action)
    VALUES (?, 1, ?, ?, 1)
    ON DUPLICATE KEY UPDATE
      enabled = 1,
      mod_log_channel_id = VALUES(mod_log_channel_id),
      mute_role_id = VALUES(mute_role_id),
      dm_on_action = 1
  `, [GUILD_ID, ch.mod_logs, r.muted]);
  console.log('   ✅ Moderation config → #mod-logs, @Muted');

  // ── 3. Welcome Settings ──
  await pool.execute(`
    INSERT INTO welcome_settings (guild_id, channel_id, message, auto_role_id, banner_enabled, goodbye_enabled, goodbye_channel_id, goodbye_message)
    VALUES (?, ?, ?, NULL, 1, 1, ?, ?)
    ON DUPLICATE KEY UPDATE
      channel_id = VALUES(channel_id),
      message = VALUES(message),
      banner_enabled = 1,
      goodbye_enabled = 1,
      goodbye_channel_id = VALUES(goodbye_channel_id),
      goodbye_message = VALUES(goodbye_message)
  `, [
    GUILD_ID,
    ch.welcome,
    'Welcome to **YourMafia**, {user}! 🎯\n\nHead to <#' + (ch.verify || '') + '> to verify and unlock all channels.\nWe now have **{memberCount}** members!',
    ch.join_leave_log,
    '{user} has left the server. We now have **{memberCount}** members.',
  ]);
  console.log('   ✅ Welcome settings → #welcome');

  // ── 4. Suggestion Config ──
  await pool.execute(`
    INSERT INTO suggestion_config (guild_id, enabled, channel_id, staff_role_id, auto_thread, dm_on_status)
    VALUES (?, 1, ?, ?, 0, 1)
    ON DUPLICATE KEY UPDATE
      enabled = 1,
      channel_id = VALUES(channel_id),
      staff_role_id = VALUES(staff_role_id),
      auto_thread = 0,
      dm_on_status = 1
  `, [GUILD_ID, ch.suggestions, r.admin]);
  console.log('   ✅ Suggestion config → #suggestions');

  // ── 5. Ticket Config ──
  await pool.execute(`
    INSERT INTO ticket_config (guild_id, ticket_category_id, support_role_id, log_channel_id, auto_close_hours)
    VALUES (?, ?, ?, ?, 48)
    ON DUPLICATE KEY UPDATE
      ticket_category_id = VALUES(ticket_category_id),
      support_role_id = VALUES(support_role_id),
      log_channel_id = VALUES(log_channel_id),
      auto_close_hours = 48
  `, [GUILD_ID, created.categories.support, r.moderator, ch.mod_logs]);
  console.log('   ✅ Ticket config → Support category, @Moderator');

  // ── 6. Leveling Config ──
  await pool.execute(`
    INSERT INTO level_config (guild_id, enabled, xp_per_message, xp_cooldown_seconds, xp_per_voice_minute, voice_xp_enabled)
    VALUES (?, 1, 15, 60, 5, 1)
    ON DUPLICATE KEY UPDATE
      enabled = 1,
      xp_per_message = 15,
      xp_cooldown_seconds = 60,
      xp_per_voice_minute = 5,
      voice_xp_enabled = 1
  `, [GUILD_ID]);
  console.log('   ✅ Leveling config → 15 XP/msg, 5 XP/voice min');

  // ── 7. Verification Reaction Role Panel ──
  // Create a panel that gives @Verified on button click
  await pool.execute(`
    INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type, max_selections)
    VALUES (?, ?, '', 'Verification', 'Click to verify and access the server!', '#3498DB', 'normal', 'button', NULL)
  `, [GUILD_ID, ch.verify]);

  const [[panelRow]] = await pool.execute('SELECT LAST_INSERT_ID() as id');
  const verifyPanelId = panelRow.id;

  if (r.verified) {
    await pool.execute(`
      INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label)
      VALUES (?, ?, '✅', 'Verify')
    `, [verifyPanelId, r.verified]);
  }
  console.log(`   ✅ Verification panel (ID: ${verifyPanelId}) → #verify, @Verified`);
}
```

**Step 2: Commit**

```bash
git add setup-yourmafia-server.js
git commit -m "feat: add bot DB configuration for all features"
```

---

### Task 6: Security Configuration

**Files:**
- Modify: `setup-yourmafia-server.js`

**Step 1: Add security config function**

Follows the exact same pattern as `setup-server-security.js`.

```js
async function configureSecurity() {
  const ch = created.channels;
  const r = created.roles;

  console.log('\n📋 Configuring Security...');

  // Clear existing rules for this guild
  await pool.execute('DELETE FROM automod_rules WHERE guild_id = ?', [GUILD_ID]);

  // Anti-Spam
  await pool.execute(`
    INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
    VALUES (?, 'anti_spam', ?, 'mute', 5, 1, ?, ?)
  `, [
    GUILD_ID,
    JSON.stringify({ message_threshold: 5, time_window_seconds: 5, duplicate_threshold: 3 }),
    JSON.stringify([ch.bot_testing]),
    JSON.stringify([r.owner, r.developer, r.head_admin, r.admin, r.moderator].filter(Boolean)),
  ]);
  console.log('   ✅ Anti-spam: 5 msgs/5 sec = 5min mute');

  // Discord Invites
  await pool.execute(`
    INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
    VALUES (?, 'discord_invites', ?, 'warn', NULL, 1, ?, ?)
  `, [
    GUILD_ID,
    JSON.stringify({ allow_own_server: true, allow_partnered: false, delete_message: true }),
    JSON.stringify([ch.bot_testing]),
    JSON.stringify([r.owner, r.developer, r.head_admin, r.admin, r.moderator, r.vip].filter(Boolean)),
  ]);
  console.log('   ✅ Invite filter: Block external invites (VIP+ exempt)');

  // Mass Mentions
  await pool.execute(`
    INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
    VALUES (?, 'mass_mentions', ?, 'mute', 10, 1, ?, ?)
  `, [
    GUILD_ID,
    JSON.stringify({ max_mentions: 5, max_role_mentions: 3, delete_message: true }),
    JSON.stringify([]),
    JSON.stringify([r.owner, r.admin, r.moderator].filter(Boolean)),
  ]);
  console.log('   ✅ Mass mentions: 5+ mentions = 10min mute');

  // All Caps
  await pool.execute(`
    INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
    VALUES (?, 'all_caps', ?, 'warn', NULL, 1, ?, ?)
  `, [
    GUILD_ID,
    JSON.stringify({ min_length: 10, caps_percentage: 70, delete_message: false }),
    JSON.stringify([ch.bot_testing]),
    JSON.stringify([r.owner, r.admin, r.moderator].filter(Boolean)),
  ]);
  console.log('   ✅ All caps: 70%+ caps over 10 chars = warn');

  // Banned Words
  await pool.execute(`
    INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
    VALUES (?, 'banned_words', ?, 'warn', NULL, 1, ?, ?)
  `, [
    GUILD_ID,
    JSON.stringify({ words: ['n1gger', 'n1gga', 'f4ggot', 'f4g', 'k1ke', 'ch1nk', 'sp1c', 'tr4nny'], match_type: 'contains', delete_message: true }),
    JSON.stringify([]),
    JSON.stringify([]),
  ]);
  console.log('   ✅ Banned words: Evasion-resistant slur filter');

  // Heat System
  await pool.execute(`
    INSERT INTO automod_heat_config (guild_id, is_enabled, heat_values, decay_minutes, action_thresholds)
    VALUES (?, 1, ?, 15, ?)
    ON DUPLICATE KEY UPDATE is_enabled = 1, heat_values = VALUES(heat_values), decay_minutes = 15, action_thresholds = VALUES(action_thresholds)
  `, [
    GUILD_ID,
    JSON.stringify({ spam: 20, mention: 15, caps: 5, invite: 25, banned_word: 30, link: 10 }),
    JSON.stringify({ warn: 25, mute_5min: 50, mute_30min: 75, kick: 100, ban: 150 }),
  ]);
  console.log('   ✅ Heat system: 25=warn, 50=5min mute, 75=30min mute, 100=kick, 150=ban');

  // Spam Config
  await pool.execute(`
    INSERT INTO automod_spam_config (guild_id, time_window, max_messages, max_mentions, max_emojis, max_repeated_chars, action, enabled)
    VALUES (?, 5, 5, 5, 15, 15, 'mute', 1)
    ON DUPLICATE KEY UPDATE time_window = 5, max_messages = 5, max_mentions = 5, max_emojis = 15, max_repeated_chars = 15, action = 'mute', enabled = 1
  `, [GUILD_ID]);
  console.log('   ✅ Spam config: 5msg/5sec, 5 mentions, 15 emojis');

  // Escalation Rules
  await pool.execute('DELETE FROM escalation_rules WHERE guild_id = ?', [GUILD_ID]);
  for (const [count, hours, action, duration] of [
    [3, 24, 'mute', 30], [5, 48, 'mute', 120], [7, 168, 'kick', null], [10, 720, 'ban', null],
  ]) {
    await pool.execute(`
      INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes)
      VALUES (?, ?, ?, ?, ?)
    `, [GUILD_ID, count, hours, action, duration]);
  }
  console.log('   ✅ Escalation: 3→30min mute, 5→2h mute, 7→kick, 10→ban');

  // Anti-Nuke
  await pool.execute(`
    INSERT INTO anti_nuke_config (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger, alert_channel_id)
    VALUES (?, 1, 3, 3, 5, 'kick', ?)
    ON DUPLICATE KEY UPDATE enabled = 1, max_channel_deletes = 3, max_role_deletes = 3, max_kick_bans = 5, action_on_trigger = 'kick', alert_channel_id = VALUES(alert_channel_id)
  `, [GUILD_ID, ch.mod_logs]);
  console.log('   ✅ Anti-nuke: 3 deletes or 5 bans = kick + alert');

  // Raid Detection
  await pool.execute(`
    INSERT INTO raid_detection_config (guild_id, enabled, join_threshold, join_timeframe_seconds, new_account_age_hours, new_account_ratio, action, alert_channel_id, mute_duration_minutes, purge_messages)
    VALUES (?, 1, 8, 60, 168, 0.70, 'alert', ?, 60, 0)
    ON DUPLICATE KEY UPDATE enabled = 1, join_threshold = 8, join_timeframe_seconds = 60, new_account_age_hours = 168, new_account_ratio = 0.70, action = 'alert', alert_channel_id = VALUES(alert_channel_id)
  `, [GUILD_ID, ch.staff_chat]);
  console.log('   ✅ Raid detection: 8 joins/60s → alert #staff-chat');

  // Adaptive Spam
  await pool.execute(`
    INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes, deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action, alert_channel_id)
    VALUES (?, 1, 3, 5, 2.00, 1.50, 2.00, 'alert', ?)
    ON DUPLICATE KEY UPDATE enabled = 1, cross_channel_threshold = 3, cross_channel_timeframe_minutes = 5, action = 'alert', alert_channel_id = VALUES(alert_channel_id)
  `, [GUILD_ID, ch.mod_logs]);
  console.log('   ✅ Adaptive spam: Cross-channel detection enabled');

  // Selfbot Detection
  await pool.execute(`
    INSERT INTO selfbot_detection_config (guild_id, enabled, min_response_time_ms, message_burst_threshold, message_burst_window_ms, pattern_threshold, action, alert_channel_id, exempt_roles)
    VALUES (?, 1, 50, 20, 1000, 3, 'alert', ?, ?)
    ON DUPLICATE KEY UPDATE enabled = 1, alert_channel_id = VALUES(alert_channel_id), exempt_roles = VALUES(exempt_roles)
  `, [
    GUILD_ID,
    ch.mod_logs,
    JSON.stringify([r.owner, r.developer, r.admin, r.moderator].filter(Boolean)),
  ]);
  console.log('   ✅ Selfbot detection: 20 msg/sec burst threshold');
}
```

**Step 2: Commit**

```bash
git add setup-yourmafia-server.js
git commit -m "feat: add security configuration to YourMafia setup"
```

---

### Task 7: Custom Bot Registration + Main Setup Function

**Files:**
- Modify: `setup-yourmafia-server.js`

**Step 1: Add custom bot registration and the main `setup()` function**

Register the bot in `custom_bots` and `guild_bot_mapping` tables so the main CertiFriedUtility instance ignores this guild.

```js
async function registerCustomBot() {
  console.log('\n📋 Registering Custom Bot...');

  // Get bot user info from Discord
  const botUser = await fetchDiscord('/users/@me');
  const botId = botUser.id;
  const botName = botUser.username;
  console.log(`   Bot: ${botName} (${botId})`);

  // Encrypt the token for storage
  const encryptedToken = encryption.encrypt(BOT_TOKEN);

  // Register in custom_bots table
  await pool.execute(`
    INSERT INTO custom_bots (bot_id, bot_name, bot_token, client_id, owner_user_id, enabled, approved)
    VALUES (?, ?, ?, ?, ?, 1, 1)
    ON DUPLICATE KEY UPDATE
      bot_name = VALUES(bot_name),
      bot_token = VALUES(bot_token),
      enabled = 1,
      approved = 1
  `, [botId, botName, JSON.stringify(encryptedToken), botId, process.env.BOT_OWNER_ID || '0']);
  console.log('   ✅ Bot registered in custom_bots');

  // Map guild to this bot
  await pool.execute(`
    INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_by)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE bot_id = ?, assigned_by = ?, assigned_at = CURRENT_TIMESTAMP
  `, [GUILD_ID, botId, process.env.BOT_OWNER_ID || '0', botId, process.env.BOT_OWNER_ID || '0']);
  console.log('   ✅ Guild mapped to bot');

  return { botId, botName };
}

// ── MAIN SETUP ──
async function setup() {
  console.log('\n' + '='.repeat(70));
  console.log('  YourMafia Discord Server Setup');
  console.log('  Guild ID: ' + GUILD_ID);
  console.log('='.repeat(70) + '\n');

  try {
    // 1. Register custom bot
    const { botId, botName } = await registerCustomBot();

    // 2. Create roles
    await createRoles();

    // 3. Create channels
    await createChannels();

    // 4. Post embeds
    await postEmbeds();

    // 5. Configure bot features in DB
    await configureBotDatabase();

    // 6. Configure security
    await configureSecurity();

    // ── SUMMARY ──
    console.log('\n' + '='.repeat(70));
    console.log('  ✅ YOURMAFIA SERVER SETUP COMPLETE!');
    console.log('='.repeat(70));

    console.log(`\n  Bot: ${botName} (${botId})`);

    console.log('\n📋 ROLES CREATED:');
    for (const [key, id] of Object.entries(created.roles)) {
      console.log(`   • @${key.replace(/_/g, ' ')}: ${id}`);
    }

    console.log('\n📋 CHANNELS CREATED:');
    for (const [key, id] of Object.entries(created.channels)) {
      console.log(`   • #${key.replace(/_/g, '-')}: ${id}`);
    }

    console.log('\n📋 CATEGORIES CREATED:');
    for (const [key, id] of Object.entries(created.categories)) {
      console.log(`   • ${key}: ${id}`);
    }

    console.log('\n💡 NEXT STEPS:');
    console.log('   1. Deploy commands: node scripts/deploy-commands-to-bot.js ' + botId);
    console.log('   2. Restart the main bot (PM2): pm2 restart CertiFriedUtility');
    console.log('   3. Run /panel deploy in #verify to activate the verification button');
    console.log('   4. Run /panel deploy in #roles if you add opt-in role panels');
    console.log('   5. Assign yourself the @Owner role');
    console.log('   6. Test all channels and permissions');
    console.log('\n');

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

setup().catch(console.error);
```

**Step 2: Run the script (dry test with correct token)**

Run: `node setup-yourmafia-server.js "<TOKEN>"`
Expected: Roles, channels, embeds created; DB configured; summary printed.

**Step 3: Commit**

```bash
git add setup-yourmafia-server.js
git commit -m "feat: complete YourMafia server setup script"
```

---

### Task 8: Deploy Commands + Verify

**Step 1: Deploy slash commands to the custom bot**

Run: `node scripts/deploy-commands-to-bot.js <BOT_ID>`

Expected: Commands deployed successfully to the guild.

**Step 2: Restart the main bot**

Run: `pm2 restart CertiFriedUtility`

Expected: Bot restarts, picks up the new custom bot from DB, initializes it.

**Step 3: Verify in Discord**

- Check that all channels/categories exist with correct permissions
- Verify an unverified user can only see #welcome and #verify
- Check that embeds appear in #rules, #verify, #faq, #open-ticket
- Test the verification button (once /panel deploy is run)
- Check staff channels are hidden from non-staff

**Step 4: Final commit**

```bash
git add setup-yourmafia-server.js docs/plans/
git commit -m "docs: add YourMafia server setup design and implementation plan"
```
