/**
 * YourMafia Discord Server Setup
 * Guild ID: 1475352754682597468
 * Bot: Your Mafia (custom CertiFriedUtility instance)
 *
 * Creates all roles, categories, channels, permissions, embeds,
 * verification gate, and bot DB configurations for the YourMafia game server.
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
  console.error('❌ No bot token provided.');
  console.error('   Usage: node setup-yourmafia-server.js <BOT_TOKEN>');
  console.error('   Or set YOURMAFIA_BOT_TOKEN in .env');
  process.exit(1);
}

// Storage for created resource IDs
const created = {
  categories: {},
  channels: {},
  roles: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Discord REST API Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDiscord(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${API_BASE}${endpoint}`, options);

  if (response.status === 429) {
    const retryData = await response.json();
    const retryAfter = (retryData.retry_after || 1) * 1000;
    console.log(`   ⏳ Rate limited, waiting ${retryAfter}ms...`);
    await sleep(retryAfter + 100);
    return fetchDiscord(endpoint, method, body);
  }

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

async function createChannel(name, type, parentId, topic = null, permissionOverwrites = null) {
  const icon = type === 2 ? '🔊' : '#';
  console.log(`   Creating channel: ${icon}${name}`);
  const data = {
    name,
    type,
    parent_id: parentId,
  };
  if (topic) data.topic = topic;
  if (permissionOverwrites) data.permission_overwrites = permissionOverwrites;
  return fetchDiscord(`/guilds/${GUILD_ID}/channels`, 'POST', data);
}

async function createRole(name, color, hoist = false, permissions = '0') {
  console.log(`   Creating role: @${name}`);
  return fetchDiscord(`/guilds/${GUILD_ID}/roles`, 'POST', {
    name,
    color,
    hoist,
    mentionable: false,
    permissions,
  });
}

async function sendMessage(channelId, content) {
  return fetchDiscord(`/channels/${channelId}/messages`, 'POST', content);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission Constants
// ─────────────────────────────────────────────────────────────────────────────

const PERM = {
  VIEW_CHANNEL:       1n << 10n,
  SEND_MESSAGES:      1n << 11n,
  EMBED_LINKS:        1n << 14n,
  ATTACH_FILES:       1n << 15n,
  READ_HISTORY:       1n << 16n,
  ADD_REACTIONS:      1n << 6n,
  USE_EXT_EMOJI:      1n << 18n,
  MANAGE_MESSAGES:    1n << 13n,
  MANAGE_CHANNELS:    1n << 4n,
  MANAGE_ROLES:       1n << 28n,
  KICK_MEMBERS:       1n << 1n,
  BAN_MEMBERS:        1n << 2n,
  MODERATE_MEMBERS:   1n << 40n,
  MANAGE_SERVER:      1n << 5n,
  ADMINISTRATOR:      1n << 3n,
  CONNECT:            1n << 20n,
  SPEAK:              1n << 21n,
};

const BASIC_TEXT = (
  PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES | PERM.READ_HISTORY |
  PERM.ADD_REACTIONS | PERM.EMBED_LINKS | PERM.ATTACH_FILES | PERM.USE_EXT_EMOJI
).toString();

const READ_ONLY = (PERM.VIEW_CHANNEL | PERM.READ_HISTORY).toString();
const DENY_VIEW = PERM.VIEW_CHANNEL.toString();
const DENY_SEND = PERM.SEND_MESSAGES.toString();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Register Custom Bot
// ─────────────────────────────────────────────────────────────────────────────

async function registerCustomBot() {
  console.log('📋 Registering Custom Bot...');

  const botUser = await fetchDiscord('/users/@me');
  const botId = botUser.id;
  const botName = botUser.username;
  console.log(`   Bot: ${botName} (${botId})`);

  // Encrypt token for DB storage
  const encryptedToken = encryption.encrypt(BOT_TOKEN);

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

  await pool.execute(`
    INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_by)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE bot_id = ?, assigned_by = ?, assigned_at = CURRENT_TIMESTAMP
  `, [GUILD_ID, botId, process.env.BOT_OWNER_ID || '0', botId, process.env.BOT_OWNER_ID || '0']);
  console.log('   ✅ Guild mapped to bot');

  return { botId, botName };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Create Roles
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_DEFS = [
  { key: 'quarantine',  name: 'Quarantine',    color: 0xE74C3C, hoist: false, permissions: '0' },
  { key: 'muted',       name: 'Muted',         color: 0x95A5A6, hoist: false, permissions: '0' },
  { key: 'verified',    name: 'Verified',      color: 0x3498DB, hoist: false, permissions: '0' },
  { key: 'og_player',   name: 'OG Player',     color: 0x9B59B6, hoist: true,  permissions: '0' },
  { key: 'vip',         name: 'VIP',           color: 0xF1C40F, hoist: true,  permissions: '0' },
  { key: 'trial_mod',   name: 'Trial Mod',     color: 0x27AE60, hoist: true,
    permissions: (PERM.SEND_MESSAGES | PERM.MANAGE_MESSAGES | PERM.MODERATE_MEMBERS).toString() },
  { key: 'moderator',   name: 'Moderator',     color: 0x2ECC71, hoist: true,
    permissions: (PERM.KICK_MEMBERS | PERM.SEND_MESSAGES | PERM.MANAGE_MESSAGES | PERM.MODERATE_MEMBERS).toString() },
  { key: 'admin',       name: 'Admin',         color: 0xFF8C00, hoist: true,
    permissions: (PERM.KICK_MEMBERS | PERM.BAN_MEMBERS | PERM.SEND_MESSAGES | PERM.MANAGE_MESSAGES).toString() },
  { key: 'head_admin',  name: 'Head Admin',    color: 0xFF4500, hoist: true,
    permissions: (PERM.KICK_MEMBERS | PERM.BAN_MEMBERS | PERM.MANAGE_MESSAGES | PERM.MANAGE_ROLES).toString() },
  { key: 'developer',   name: 'Developer',     color: 0xE91E63, hoist: true,
    permissions: (PERM.MANAGE_CHANNELS | PERM.MANAGE_SERVER | PERM.MANAGE_ROLES).toString() },
  { key: 'owner',       name: 'Owner',         color: 0xFF0000, hoist: true,
    permissions: PERM.ADMINISTRATOR.toString() },
];

async function createRoles() {
  console.log('\n📋 Creating Roles...');

  for (const roleDef of ROLE_DEFS) {
    try {
      const role = await createRole(roleDef.name, roleDef.color, roleDef.hoist, roleDef.permissions);
      created.roles[roleDef.key] = role.id;
      console.log(`   ✅ @${roleDef.name} (${role.id})`);
      await sleep(400);
    } catch (e) {
      console.log(`   ⚠️ Failed @${roleDef.name}: ${e.message}`);
    }
  }

  // Reorder roles so hierarchy is correct
  console.log('   Reordering roles...');
  const positions = ROLE_DEFS
    .map((r, i) => ({ id: created.roles[r.key], position: i + 1 }))
    .filter(r => r.id);

  try {
    await fetchDiscord(`/guilds/${GUILD_ID}/roles`, 'PATCH', positions);
    console.log('   ✅ Roles reordered by hierarchy');
  } catch (e) {
    console.log(`   ⚠️ Could not reorder roles: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Create Categories & Channels
// ─────────────────────────────────────────────────────────────────────────────

async function createChannels() {
  const r = created.roles;

  // Permission overwrite builders
  function verifiedOnly() {
    return [
      { id: GUILD_ID, type: 0, allow: '0', deny: DENY_VIEW },
      r.verified && { id: r.verified, type: 0, allow: READ_ONLY, deny: '0' },
      r.muted && { id: r.muted, type: 0, allow: PERM.VIEW_CHANNEL.toString(), deny: DENY_SEND },
    ].filter(Boolean);
  }

  function staffOnly() {
    return [
      { id: GUILD_ID, type: 0, allow: '0', deny: DENY_VIEW },
      r.trial_mod && { id: r.trial_mod, type: 0, allow: READ_ONLY, deny: '0' },
      r.moderator && { id: r.moderator, type: 0, allow: BASIC_TEXT, deny: '0' },
      r.admin && { id: r.admin, type: 0, allow: BASIC_TEXT, deny: '0' },
      r.head_admin && { id: r.head_admin, type: 0, allow: BASIC_TEXT, deny: '0' },
      r.developer && { id: r.developer, type: 0, allow: BASIC_TEXT, deny: '0' },
      r.owner && { id: r.owner, type: 0, allow: BASIC_TEXT, deny: '0' },
    ].filter(Boolean);
  }

  function readOnlyForVerified() {
    return [
      { id: GUILD_ID, type: 0, allow: '0', deny: DENY_VIEW },
      r.verified && { id: r.verified, type: 0, allow: READ_ONLY, deny: DENY_SEND },
    ].filter(Boolean);
  }

  // ── VERIFICATION (visible to everyone, read-only) ──
  console.log('\n📋 Creating VERIFICATION Category...');
  const verifCat = await createCategory('Verification', [
    { id: GUILD_ID, type: 0, allow: READ_ONLY, deny: DENY_SEND },
  ]);
  created.categories.verification = verifCat.id;
  await sleep(400);

  let ch = await createChannel('welcome', 0, verifCat.id, 'Welcome to YourMafia!');
  created.channels.welcome = ch.id;
  await sleep(400);

  ch = await createChannel('verify', 0, verifCat.id, 'Click the button to verify and gain access');
  created.channels.verify = ch.id;
  await sleep(400);

  // ── INFORMATION (read-only for verified) ──
  console.log('\n📋 Creating INFORMATION Category...');
  const infoCat = await createCategory('Information', readOnlyForVerified());
  created.categories.information = infoCat.id;
  await sleep(400);

  const infoChannels = [
    ['rules', 'rules', 'Server rules — read before participating'],
    ['announcements', 'announcements', 'Game updates and news'],
    ['patch_notes', 'patch-notes', 'YourMafia game changelog'],
    ['roles', 'roles', 'Pick your roles here'],
    ['faq', 'faq', 'Frequently asked questions'],
  ];
  for (const [key, name, topic] of infoChannels) {
    ch = await createChannel(name, 0, infoCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(400);
  }

  // ── COMMUNITY ──
  console.log('\n📋 Creating COMMUNITY Category...');
  const commCat = await createCategory('Community', verifiedOnly());
  created.categories.community = commCat.id;
  await sleep(400);

  const commChannels = [
    ['general', 'general', 'Main chat — talk about anything'],
    ['off_topic', 'off-topic', 'Non-game discussion'],
    ['media', 'media', 'Screenshots, videos, memes'],
    ['introductions', 'introductions', 'Introduce yourself to the community'],
  ];
  for (const [key, name, topic] of commChannels) {
    ch = await createChannel(name, 0, commCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(400);
  }

  // ── YOURMAFIA GAME ──
  console.log('\n📋 Creating YOURMAFIA GAME Category...');
  const gameCat = await createCategory('YourMafia Game', verifiedOnly());
  created.categories.game = gameCat.id;
  await sleep(400);

  const gameChannels = [
    ['game_chat', 'game-chat', 'Discuss strategies, gangs, and crime'],
    ['gang_recruitment', 'gang-recruitment', 'Gangs recruiting members'],
    ['trading', 'trading', 'In-game item and credit trading'],
    ['game_events', 'game-events', 'Game event feeds (automated)'],
    ['leaderboards', 'leaderboards', 'Top players, gangs, and stats'],
  ];
  for (const [key, name, topic] of gameChannels) {
    ch = await createChannel(name, 0, gameCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(400);
  }

  // ── FEEDBACK ──
  console.log('\n📋 Creating FEEDBACK Category...');
  const feedbackCat = await createCategory('Feedback', verifiedOnly());
  created.categories.feedback = feedbackCat.id;
  await sleep(400);

  const feedbackChannels = [
    ['suggestions', 'suggestions', 'Submit and vote on suggestions'],
    ['bug_reports', 'bug-reports', 'Report game bugs here'],
    ['changelog', 'changelog', 'Staff responses to bugs and suggestions'],
  ];
  for (const [key, name, topic] of feedbackChannels) {
    ch = await createChannel(name, 0, feedbackCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(400);
  }

  // ── SUPPORT ──
  console.log('\n📋 Creating SUPPORT Category...');
  const supportCat = await createCategory('Support', verifiedOnly());
  created.categories.support = supportCat.id;
  await sleep(400);

  ch = await createChannel('open-ticket', 0, supportCat.id, 'Click below to open a support ticket');
  created.channels.open_ticket = ch.id;
  await sleep(400);

  // ── VOICE ──
  console.log('\n📋 Creating VOICE Category...');
  const voiceCat = await createCategory('Voice', verifiedOnly());
  created.categories.voice = voiceCat.id;
  await sleep(400);

  ch = await createChannel('General Voice', 2, voiceCat.id);
  created.channels.general_voice = ch.id;
  await sleep(400);

  ch = await createChannel('AFK', 2, voiceCat.id);
  created.channels.afk = ch.id;
  await sleep(400);

  // Set AFK channel for the guild
  try {
    await fetchDiscord(`/guilds/${GUILD_ID}`, 'PATCH', {
      afk_channel_id: created.channels.afk,
      afk_timeout: 300,
    });
    console.log('   ✅ AFK channel set (5 min timeout)');
  } catch (e) {
    console.log(`   ⚠️ Could not set AFK: ${e.message}`);
  }

  // ── STAFF AREA ──
  console.log('\n📋 Creating STAFF AREA Category...');
  const staffCat = await createCategory('Staff Area', staffOnly());
  created.categories.staff = staffCat.id;
  await sleep(400);

  const staffChannels = [
    ['staff_chat', 'staff-chat', 'Staff discussion'],
    ['mod_actions', 'mod-actions', 'Moderation action log'],
    ['staff_todos', 'staff-todos', 'Task tracking'],
    ['dev_chat', 'dev-chat', 'Developer discussion'],
    ['bot_testing', 'bot-testing', 'Bot command testing'],
  ];
  for (const [key, name, topic] of staffChannels) {
    ch = await createChannel(name, 0, staffCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(400);
  }

  // ── LOGS ──
  console.log('\n📋 Creating LOGS Category...');
  const logsCat = await createCategory('Logs', staffOnly());
  created.categories.logs = logsCat.id;
  await sleep(400);

  const logChannels = [
    ['audit_log', 'audit-log', 'General server logs'],
    ['mod_logs', 'mod-logs', 'Moderation actions'],
    ['automod_logs', 'automod-logs', 'AutoMod triggers'],
    ['join_leave_log', 'join-leave-log', 'Member join/leave tracking'],
  ];
  for (const [key, name, topic] of logChannels) {
    ch = await createChannel(name, 0, logsCat.id, topic);
    created.channels[key] = ch.id;
    await sleep(400);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Post Embeds
// ─────────────────────────────────────────────────────────────────────────────

async function postEmbeds() {
  console.log('\n📋 Posting Embeds...');
  const ch = created.channels;

  // Rules
  if (ch.rules) {
    await sendMessage(ch.rules, {
      embeds: [{
        title: '📜 YourMafia Community Rules',
        description: [
          '**1. Respect All Members** — No harassment, hate speech, discrimination, or personal attacks.',
          '**2. No Spam** — No flooding, excessive caps, repeated messages, or meaningless content.',
          '**3. No Cheating Discussion** — Do not share exploits, hacks, or methods to cheat in YourMafia.',
          '**4. Keep It Legal** — No illegal content, doxxing, threats, or NSFW.',
          '**5. English Only** — Main channels are English. Use <#' + (ch.off_topic || '') + '> for other languages.',
          '**6. No Advertising** — No unsolicited promotion of other games, servers, or services.',
          '**7. Use Channels Properly** — Keep discussions in their relevant channels.',
          '**8. Follow Discord ToS** — All Discord Terms of Service and Community Guidelines apply.',
          '**9. Listen to Staff** — Moderator decisions are final. Use <#' + (ch.open_ticket || '') + '> to appeal.',
          '**10. Have Fun** — This is a community. Enjoy the game and each other.',
        ].join('\n\n'),
        color: 0xFF4500,
        footer: { text: 'Violations result in progressive punishment: Warning → Mute → Kick → Ban' },
      }],
    });
    console.log('   ✅ Rules embed → #rules');
    await sleep(500);
  }

  // Verification placeholder
  if (ch.verify) {
    await sendMessage(ch.verify, {
      embeds: [{
        title: '🔓 Verify to Access YourMafia',
        description: [
          'Welcome to the **YourMafia** Discord server!',
          '',
          'To gain access to all channels:',
          '1. Read the rules in <#' + (ch.rules || '') + '>',
          '2. Click the **Verify** button below',
          '',
          '> By verifying, you agree to follow our community rules.',
        ].join('\n'),
        color: 0x3498DB,
        footer: { text: 'Run /panel deploy in this channel to activate the verification button' },
      }],
    });
    console.log('   ✅ Verification embed → #verify');
    await sleep(500);
  }

  // FAQ
  if (ch.faq) {
    await sendMessage(ch.faq, {
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
          'A: Use <#' + (ch.bug_reports || '') + '> or open a ticket in <#' + (ch.open_ticket || '') + '>.',
          '',
          '**Q: How do I suggest a feature?**',
          'A: Use the `/engage suggest` command in <#' + (ch.suggestions || '') + '>.',
          '',
          '**Q: I got muted/banned unfairly!**',
          'A: Open a support ticket in <#' + (ch.open_ticket || '') + '> to appeal.',
          '',
          '**Q: Can I advertise my gang?**',
          'A: Yes! Use <#' + (ch.gang_recruitment || '') + '> for gang recruitment.',
        ].join('\n'),
        color: 0x5865F2,
      }],
    });
    console.log('   ✅ FAQ embed → #faq');
    await sleep(500);
  }

  // Ticket panel
  if (ch.open_ticket) {
    await sendMessage(ch.open_ticket, {
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
          '> Use `/support ticket create` to open a ticket.',
        ].join('\n'),
        color: 0x2ECC71,
        footer: { text: 'Staff will respond as soon as possible' },
      }],
    });
    console.log('   ✅ Ticket panel embed → #open-ticket');
    await sleep(500);
  }

  // Announcements welcome
  if (ch.announcements) {
    await sendMessage(ch.announcements, {
      embeds: [{
        title: '🎯 Welcome to YourMafia',
        description: [
          'This is the official Discord server for **YourMafia** — a browser-based mafia MMORPG.',
          '',
          'Stay tuned for:',
          '• Game updates and patch notes',
          '• Community events',
          '• Feature announcements',
          '',
          'Make sure to check out <#' + (ch.rules || '') + '> and introduce yourself in <#' + (ch.introductions || '') + '>!',
        ].join('\n'),
        color: 0xFF4500,
        thumbnail: { url: 'https://cdn.discordapp.com/embed/avatars/0.png' },
      }],
    });
    console.log('   ✅ Welcome announcement → #announcements');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Bot Database Configuration
// ─────────────────────────────────────────────────────────────────────────────

async function configureBotDatabase() {
  const ch = created.channels;
  const r = created.roles;

  console.log('\n📋 Configuring Bot Database...');

  // Logging
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
      'join-gate', 'system', 'xp', 'tickets',
    ]),
  ]);
  console.log('   ✅ Logging → #audit-log (all events)');

  // Moderation
  await pool.execute(`
    INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      mod_log_channel_id = VALUES(mod_log_channel_id),
      muted_role_id = VALUES(muted_role_id)
  `, [GUILD_ID, ch.mod_logs, r.muted]);
  console.log('   ✅ Moderation → #mod-logs, @Muted');

  // Welcome
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
  console.log('   ✅ Welcome → #welcome (banner enabled)');

  // Suggestions
  await pool.execute(`
    INSERT INTO suggestion_config (guild_id, enabled, suggestions_channel_id, require_approval)
    VALUES (?, 1, ?, 1)
    ON DUPLICATE KEY UPDATE
      enabled = 1,
      suggestions_channel_id = VALUES(suggestions_channel_id),
      require_approval = 1
  `, [GUILD_ID, ch.suggestions]);
  console.log('   ✅ Suggestions → #suggestions');

  // Tickets
  await pool.execute(`
    INSERT INTO ticket_config (guild_id, ticket_category_id, support_role_id, log_channel_id, auto_close_hours)
    VALUES (?, ?, ?, ?, 48)
    ON DUPLICATE KEY UPDATE
      ticket_category_id = VALUES(ticket_category_id),
      support_role_id = VALUES(support_role_id),
      log_channel_id = VALUES(log_channel_id),
      auto_close_hours = 48
  `, [GUILD_ID, created.categories.support, r.moderator, ch.mod_logs]);
  console.log('   ✅ Tickets → Support category, @Moderator, 48h auto-close');

  // Leveling
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
  console.log('   ✅ Leveling → 15 XP/msg, 5 XP/voice min');

  // Verification Reaction Role Panel
  await pool.execute(`
    INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type, max_selections)
    VALUES (?, ?, '', 'Verification', 'Click to verify and access the server!', '#3498DB', 'normal', 'button', NULL)
  `, [GUILD_ID, ch.verify]);

  const [[panelRow]] = await pool.execute('SELECT LAST_INSERT_ID() as id');
  const verifyPanelId = panelRow.id;

  if (r.verified) {
    await pool.execute(`
      INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id)
      VALUES (?, ?, '✅')
    `, [verifyPanelId, r.verified]);
  }
  console.log(`   ✅ Verification panel (ID: ${verifyPanelId}) → #verify, @Verified`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Security Configuration
// ─────────────────────────────────────────────────────────────────────────────

async function configureSecurity() {
  const ch = created.channels;
  const r = created.roles;

  console.log('\n📋 Configuring Security...');

  const staffRoles = [r.owner, r.developer, r.head_admin, r.admin, r.moderator].filter(Boolean);

  // Clear existing automod rules
  await pool.execute('DELETE FROM automod_rules WHERE guild_id = ?', [GUILD_ID]);

  // Anti-Spam
  await pool.execute(`
    INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
    VALUES (?, 'anti_spam', ?, 'mute', 5, 1, ?, ?)
  `, [
    GUILD_ID,
    JSON.stringify({ message_threshold: 5, time_window_seconds: 5, duplicate_threshold: 3 }),
    JSON.stringify([ch.bot_testing].filter(Boolean)),
    JSON.stringify(staffRoles),
  ]);
  console.log('   ✅ Anti-spam: 5 msgs/5 sec = 5min mute');

  // Discord Invites
  await pool.execute(`
    INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
    VALUES (?, 'discord_invites', ?, 'warn', NULL, 1, ?, ?)
  `, [
    GUILD_ID,
    JSON.stringify({ allow_own_server: true, allow_partnered: false, delete_message: true }),
    JSON.stringify([ch.bot_testing].filter(Boolean)),
    JSON.stringify([...staffRoles, r.vip].filter(Boolean)),
  ]);
  console.log('   ✅ Invite filter: Block external (VIP+ exempt)');

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
  console.log('   ✅ Mass mentions: 5+ = 10min mute');

  // All Caps
  await pool.execute(`
    INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
    VALUES (?, 'all_caps', ?, 'warn', NULL, 1, ?, ?)
  `, [
    GUILD_ID,
    JSON.stringify({ min_length: 10, caps_percentage: 70, delete_message: false }),
    JSON.stringify([ch.bot_testing].filter(Boolean)),
    JSON.stringify([r.owner, r.admin, r.moderator].filter(Boolean)),
  ]);
  console.log('   ✅ All caps: 70%+ over 10 chars = warn');

  // Banned Words
  await pool.execute(`
    INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
    VALUES (?, 'banned_words', ?, 'warn', NULL, 1, ?, ?)
  `, [
    GUILD_ID,
    JSON.stringify({
      words: ['n1gger', 'n1gga', 'f4ggot', 'f4g', 'k1ke', 'ch1nk', 'sp1c', 'tr4nny'],
      match_type: 'contains',
      delete_message: true,
    }),
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
  console.log('   ✅ Heat: 25=warn, 50=5min mute, 75=30min mute, 100=kick, 150=ban');

  // Spam Config
  await pool.execute(`
    INSERT INTO automod_spam_config (guild_id, time_window, max_messages, max_mentions, max_emojis, max_repeated_chars, action, enabled)
    VALUES (?, 5, 5, 5, 15, 15, 'mute', 1)
    ON DUPLICATE KEY UPDATE time_window = 5, max_messages = 5, max_mentions = 5, max_emojis = 15, max_repeated_chars = 15, action = 'mute', enabled = 1
  `, [GUILD_ID]);
  console.log('   ✅ Spam config: 5msg/5sec, 5 mentions, 15 emojis');

  // Escalation Rules
  await pool.execute('DELETE FROM escalation_rules WHERE guild_id = ?', [GUILD_ID]);
  const escalations = [
    [3, 24, 'mute', 30],
    [5, 48, 'mute', 120],
    [7, 168, 'kick', null],
    [10, 720, 'ban', null],
  ];
  for (const [count, hours, action, duration] of escalations) {
    await pool.execute(`
      INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes)
      VALUES (?, ?, ?, ?, ?)
    `, [GUILD_ID, count, hours, action, duration]);
  }
  console.log('   ✅ Escalation: 3→30m mute, 5→2h mute, 7→kick, 10→ban');

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
    ON DUPLICATE KEY UPDATE enabled = 1, join_threshold = 8, join_timeframe_seconds = 60, new_account_age_hours = 168, action = 'alert', alert_channel_id = VALUES(alert_channel_id)
  `, [GUILD_ID, ch.staff_chat]);
  console.log('   ✅ Raid detection: 8 joins/60s → #staff-chat');

  // Adaptive Spam
  await pool.execute(`
    INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes, deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action, alert_channel_id)
    VALUES (?, 1, 3, 5, 2.00, 1.50, 2.00, 'alert', ?)
    ON DUPLICATE KEY UPDATE enabled = 1, cross_channel_threshold = 3, action = 'alert', alert_channel_id = VALUES(alert_channel_id)
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
    JSON.stringify(staffRoles),
  ]);
  console.log('   ✅ Selfbot detection: 20 msg/sec burst threshold');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Set Server Verification Level
// ─────────────────────────────────────────────────────────────────────────────

async function configureServerSettings() {
  console.log('\n📋 Configuring Server Settings...');

  try {
    await fetchDiscord(`/guilds/${GUILD_ID}`, 'PATCH', {
      verification_level: 2,        // Medium: must have verified email
      default_message_notifications: 1, // Only @mentions
      explicit_content_filter: 2,   // Scan all messages
    });
    console.log('   ✅ Verification level: Medium (verified email required)');
    console.log('   ✅ Default notifications: @mentions only');
    console.log('   ✅ Content filter: Scan all messages');
  } catch (e) {
    console.log(`   ⚠️ Could not configure server settings: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function setup() {
  console.log('\n' + '='.repeat(70));
  console.log('  YourMafia Discord Server Setup');
  console.log('  Guild ID: ' + GUILD_ID);
  console.log('='.repeat(70) + '\n');

  try {
    // Step 1: Register custom bot
    const { botId, botName } = await registerCustomBot();

    // Step 2: Create roles
    await createRoles();

    // Step 3: Create channels & categories
    await createChannels();

    // Step 4: Post embeds
    await postEmbeds();

    // Step 5: Configure bot features
    await configureBotDatabase();

    // Step 6: Configure security
    await configureSecurity();

    // Step 7: Server-level settings
    await configureServerSettings();

    // ── SUMMARY ──
    console.log('\n' + '='.repeat(70));
    console.log('  ✅ YOURMAFIA SERVER SETUP COMPLETE!');
    console.log('='.repeat(70));

    console.log(`\n  Bot: ${botName} (${botId})`);

    console.log('\n📋 ROLES CREATED (' + Object.keys(created.roles).length + '):');
    for (const [key, id] of Object.entries(created.roles)) {
      console.log(`   • @${key.replace(/_/g, ' ')}: ${id}`);
    }

    console.log('\n📋 CHANNELS CREATED (' + Object.keys(created.channels).length + '):');
    for (const [key, id] of Object.entries(created.channels)) {
      console.log(`   • #${key.replace(/_/g, '-')}: ${id}`);
    }

    console.log('\n📋 CATEGORIES CREATED (' + Object.keys(created.categories).length + '):');
    for (const [key, id] of Object.entries(created.categories)) {
      console.log(`   • ${key}: ${id}`);
    }

    console.log('\n📋 SECURITY:');
    console.log('   • AutoMod: anti-spam, invites, mentions, caps, banned words');
    console.log('   • Heat: Progressive punishment (15 min decay)');
    console.log('   • Escalation: 3→mute, 5→2h mute, 7→kick, 10→ban');
    console.log('   • Anti-nuke: 3 deletes = kick');
    console.log('   • Raid detection: 8 joins/60s = alert');
    console.log('   • Adaptive spam + selfbot detection');

    console.log('\n📋 BOT FEATURES:');
    console.log('   • Logging (all events) → #audit-log');
    console.log('   • Moderation logs → #mod-logs');
    console.log('   • Welcome greetings → #welcome');
    console.log('   • Suggestions → #suggestions');
    console.log('   • Tickets → Support category');
    console.log('   • Leveling/XP → enabled');
    console.log('   • Verification panel → #verify');

    console.log('\n💡 NEXT STEPS:');
    console.log('   1. Deploy commands:  node scripts/deploy-commands-to-bot.js ' + botId);
    console.log('   2. Restart main bot: pm2 restart CertiFriedUtility');
    console.log('   3. Activate verify:  /panel deploy in #verify');
    console.log('   4. Assign yourself:  @Owner role');
    console.log('   5. Test everything!');
    console.log('\n');

  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

setup().catch(console.error);
