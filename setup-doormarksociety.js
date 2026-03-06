/**
 * DoorMarkSociety Discord Server Setup
 * Guild ID: 810661128878424074
 * Bot: Sion (895823853090119701)
 *
 * Configures: rules embed, welcome/goodbye, leveling + role rewards,
 * logging, and Twitch stream tracking for bigcustybangbus.
 *
 * Usage: node setup-doormarksociety.js
 */
import dotenv from 'dotenv';
import pool from './utils/db.js';
import encryption from './utils/encryption.js';
import { getTwitchUser } from './utils/platforms/twitch-api.js';

dotenv.config();

const GUILD_ID = '810661128878424074';
const BOT_ID = '895823853090119701';
const API_BASE = 'https://discord.com/api/v10';

// Channel IDs
const CHANNELS = {
  rules: '920784595585208361',
  welcome: '920784596315013161',
  goodbye: '920784597372010517',
  levels: '920784598152151140',
  botLogs: '920787349699432469',
  communityEvents: '920784599221674025',
};

// Role IDs
const ROLES = {
  member: '920784597950791730',
  admin: '920784590308786186',
  leadAdmin: '920784589348286556',
};

// Level role rewards
const LEVEL_ROLES = [
  { level: 1,  role_id: '920784597267140638' }, // Grunt
  { level: 3,  role_id: '920784596239519815' }, // Newbie
  { level: 5,  role_id: '920784595853664327' }, // Recruit
  { level: 10, role_id: '920784595107086347' }, // Dreamer
  { level: 15, role_id: '920784594461138954' }, // Captain
  { level: 20, role_id: '920784593852956702' }, // Elite
  { level: 30, role_id: '920784593202847744' }, // Legend
  { level: 40, role_id: '920784592460472361' }, // Specialist
  { level: 50, role_id: '920784591739056148' }, // Badass
];

// Old message to delete
const OLD_RULES_MSG_ID = '920800295712325702';

let BOT_TOKEN = null;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// ─────────────────────────────────────────────────────────────────────────────
// 0. Get Bot Token from DB
// ─────────────────────────────────────────────────────────────────────────────

async function getBotToken() {
  console.log('🔑 Retrieving Sion bot token from DB...');

  const [rows] = await pool.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
    [BOT_ID]
  );

  if (!rows.length) {
    throw new Error(`Bot ${BOT_ID} not found in custom_bots table`);
  }

  const encryptedToken = typeof rows[0].bot_token === 'string'
    ? JSON.parse(rows[0].bot_token)
    : rows[0].bot_token;

  BOT_TOKEN = encryption.decrypt(encryptedToken);
  console.log('   ✅ Token decrypted successfully');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Replace Rules Embed
// ─────────────────────────────────────────────────────────────────────────────

async function replaceRulesEmbed() {
  console.log('\n📋 Step 1: Replacing Rules Embed...');

  // Delete old message
  try {
    await fetchDiscord(
      `/channels/${CHANNELS.rules}/messages/${OLD_RULES_MSG_ID}`,
      'DELETE'
    );
    console.log(`   ✅ Deleted old rules message (${OLD_RULES_MSG_ID})`);
  } catch (e) {
    console.log(`   ⚠️ Could not delete old rules message: ${e.message}`);
  }

  await sleep(500);

  // Post fresh embed
  const rulesDescription = [
    '**1.** No offensive messages or nicknames.',
    '',
    '**2.** No spam - This includes but is not limited by, loud/obnoxious noises in voice, @mention spam, character spam, image spam, and message spam.',
    '',
    '**3.** No NSFW content: This is a community for **ALL** Ages and even though the majority of us are over 18, we can\'t be promoting NSFW material to minors.',
    '',
    `**4.** No harassment - Including sexual harassment or encouraging of harassment. This includes excessive messages and unwarranted DM's. If you feel like you are being harassed or another member is sending uncomfortable messages please alert an <@&${ROLES.admin}> immediately.`,
    '',
    '**5.** No self or user bots - These are in some cases against the discord TOS and if you need a bot for something use one of the bots already in the server.',
    '',
    '**6.** Swearing is allowed so long as it isn\'t directed at another member.',
    '',
    `**7.** No sharing discords, Unless given approval by a <@&${ROLES.admin}> or an <@&${ROLES.leadAdmin}>.`,
  ].join('\n');

  const embed = {
    title: 'Rules',
    description: rulesDescription,
    color: 5724001,
  };

  const msg = await fetchDiscord(
    `/channels/${CHANNELS.rules}/messages`,
    'POST',
    { embeds: [embed] }
  );
  console.log(`   ✅ Posted new rules embed (${msg.id})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Delete Old Webhooks + Configure Welcome/Goodbye
// ─────────────────────────────────────────────────────────────────────────────

async function configureWelcome() {
  console.log('\n📋 Step 2: Configuring Welcome/Goodbye...');

  // Fetch guild webhooks and delete the BOT WELCOME ones owned by Sion
  const webhooks = await fetchDiscord(`/guilds/${GUILD_ID}/webhooks`);
  let deleted = 0;

  for (const wh of webhooks) {
    if (wh.name === 'BOT WELCOME' && wh.user?.id === BOT_ID) {
      try {
        await fetchDiscord(`/webhooks/${wh.id}`, 'DELETE');
        console.log(`   ✅ Deleted webhook "${wh.name}" (${wh.id}) in <#${wh.channel_id}>`);
        deleted++;
        await sleep(300);
      } catch (e) {
        console.log(`   ⚠️ Could not delete webhook ${wh.id}: ${e.message}`);
      }
    }
  }
  console.log(`   Deleted ${deleted} old BOT WELCOME webhooks`);

  // Insert welcome_settings
  await pool.execute(`
    INSERT INTO welcome_settings (guild_id, channel_id, message, goodbye_enabled, goodbye_channel_id, goodbye_message, auto_role_id, banner_enabled)
    VALUES (?, ?, ?, 1, ?, ?, ?, 0)
    ON DUPLICATE KEY UPDATE
      channel_id = VALUES(channel_id),
      message = VALUES(message),
      goodbye_enabled = 1,
      goodbye_channel_id = VALUES(goodbye_channel_id),
      goodbye_message = VALUES(goodbye_message),
      auto_role_id = VALUES(auto_role_id),
      banner_enabled = 0
  `, [
    GUILD_ID,
    CHANNELS.welcome,
    'Welcome {user} you are member #{count}!',
    CHANNELS.goodbye,
    '{user} just left the server!',
    ROLES.member,
  ]);
  console.log('   ✅ welcome_settings inserted');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Configure Leveling
// ─────────────────────────────────────────────────────────────────────────────

async function configureLeveling() {
  console.log('\n📋 Step 3: Configuring Leveling...');

  // Insert level_config
  await pool.execute(`
    INSERT INTO level_config (guild_id, enabled, xp_per_message, xp_cooldown_seconds, voice_xp_enabled, xp_per_voice_minute, level_up_channel_id, level_up_message)
    VALUES (?, 1, 15, 60, 1, 5, ?, ?)
    ON DUPLICATE KEY UPDATE
      enabled = 1,
      xp_per_message = 15,
      xp_cooldown_seconds = 60,
      voice_xp_enabled = 1,
      xp_per_voice_minute = 5,
      level_up_channel_id = VALUES(level_up_channel_id),
      level_up_message = VALUES(level_up_message)
  `, [
    GUILD_ID,
    CHANNELS.levels,
    'Congrats {user}! You reached **Level {level}**!',
  ]);
  console.log('   ✅ level_config inserted');

  // Clear any existing role rewards for this guild, then insert fresh
  await pool.execute(
    'DELETE FROM level_role_rewards WHERE guild_id = ?',
    [GUILD_ID]
  );

  for (const { level, role_id } of LEVEL_ROLES) {
    await pool.execute(
      'INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?, ?, ?)',
      [GUILD_ID, level, role_id]
    );
  }
  console.log(`   ✅ ${LEVEL_ROLES.length} level_role_rewards inserted`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Configure Logging
// ─────────────────────────────────────────────────────────────────────────────

async function configureLogging() {
  console.log('\n📋 Step 4: Configuring Logging...');

  const enabledEvents = JSON.stringify([
    'messageDelete',
    'messageUpdate',
    'memberUpdate',
    'memberLeave',
    'memberKick',
    'voiceUpdate',
    'ban',
    'unban',
    'roleCreate',
    'roleDelete',
    'roleUpdate',
  ]);

  await pool.execute(`
    INSERT INTO logging_config (guild_id, log_channel_id, enabled_events)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      log_channel_id = VALUES(log_channel_id),
      enabled_events = VALUES(enabled_events)
  `, [GUILD_ID, CHANNELS.botLogs, enabledEvents]);

  console.log('   ✅ logging_config inserted → #bot-logs');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Set Up Stream Notifications
// ─────────────────────────────────────────────────────────────────────────────

async function configureStreaming() {
  console.log('\n📋 Step 5: Setting Up Stream Tracking...');

  const twitchUsername = 'bigcustybangbus';

  // Look up Twitch user
  const twitchUser = await getTwitchUser(twitchUsername);
  if (!twitchUser) {
    console.log(`   ⚠️ Could not find Twitch user "${twitchUsername}" — skipping stream setup`);
    return;
  }

  console.log(`   Found Twitch user: ${twitchUser.display_name} (ID: ${twitchUser.id})`);

  // Check if streamer already exists
  const [existing] = await pool.execute(
    'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
    ['twitch', twitchUser.id]
  );

  let streamerId;
  if (existing.length > 0) {
    streamerId = existing[0].streamer_id;
    console.log(`   Streamer already exists (ID: ${streamerId})`);
  } else {
    const [result] = await pool.execute(
      'INSERT INTO streamers (username, platform, platform_user_id, profile_image_url) VALUES (?, ?, ?, ?)',
      [twitchUser.login, 'twitch', twitchUser.id, twitchUser.profile_image_url || null]
    );
    streamerId = result.insertId;
    console.log(`   ✅ Streamer created (ID: ${streamerId})`);
  }

  // Check if subscription already exists for this guild + streamer
  const [existingSub] = await pool.execute(
    'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
    [GUILD_ID, streamerId]
  );

  if (existingSub.length > 0) {
    console.log(`   Subscription already exists (ID: ${existingSub[0].subscription_id})`);
  } else {
    const [subResult] = await pool.execute(
      'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)',
      [GUILD_ID, streamerId, CHANNELS.communityEvents]
    );
    console.log(`   ✅ Subscription created (ID: ${subResult.insertId}) → #community-events`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' DoorMarkSociety (810661128878424074) — Sion Bot Setup');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    await getBotToken();
    await replaceRulesEmbed();
    await configureWelcome();
    await configureLeveling();
    await configureLogging();
    await configureStreaming();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(' ✅ All configurations complete!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\nNext steps:');
    console.log('  pm2 restart CertiFriedUtility');
    console.log('\nVerify:');
    console.log('  1. #rules — fresh embed with 7 rules');
    console.log('  2. #bot-logs — logging events should appear');
    console.log('  3. DB — level_config, level_role_rewards, welcome_settings, logging_config populated');
    console.log('  4. Stream tracking — bigcustybangbus in subscriptions table');
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    console.error(error.stack);
  }

  await pool.end();
  process.exit(0);
}

main();
