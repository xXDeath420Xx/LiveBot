/**
 * Hummus Nation Streaming Setup
 * Guild ID: 1475096615940521994
 * Bot: Hummus Nation (1478035213148754072)
 *
 * Configures: custom bot registration, streamer auto-track (no role restriction),
 * live role assignment, and explicit subscription for veryangryplatypus.
 *
 * Usage: node setup-hummusnation.js
 */
import dotenv from 'dotenv';
import pool from './utils/db.js';
import encryption from './utils/encryption.js';
import { getTwitchUser } from './utils/platforms/twitch-api.js';

dotenv.config();

const GUILD_ID = '1475096615940521994';
const BOT_ID = '1478035213148754072';
const BOT_NAME = 'Hummus Nation';
const BOT_TOKEN = process.env.HUMMUSNATION_BOT_TOKEN; // was hardcoded — use env var

const ANNOUNCEMENT_CHANNEL_ID = '1478038234310381700';
const LIVE_ROLE_ID = '1475247401945010380';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Register Custom Bot
// ─────────────────────────────────────────────────────────────────────────────

async function registerBot() {
  console.log('\n📋 Step 1: Registering Hummus Nation bot...');

  const encryptedToken = encryption.encrypt(BOT_TOKEN);

  await pool.execute(`
    INSERT INTO custom_bots (bot_id, bot_name, bot_token, client_id, owner_user_id, enabled, approved)
    VALUES (?, ?, ?, ?, '365905620060340224', 1, 1)
    ON DUPLICATE KEY UPDATE
      bot_name = VALUES(bot_name),
      bot_token = VALUES(bot_token),
      client_id = VALUES(client_id),
      enabled = 1,
      approved = 1
  `, [BOT_ID, BOT_NAME, JSON.stringify(encryptedToken), BOT_ID]);

  console.log(`   ✅ Bot ${BOT_NAME} (${BOT_ID}) registered in custom_bots`);

  await pool.execute(`
    INSERT INTO guild_bot_mapping (guild_id, bot_id)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE bot_id = VALUES(bot_id)
  `, [GUILD_ID, BOT_ID]);

  console.log(`   ✅ Guild ${GUILD_ID} mapped to bot ${BOT_ID}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Configure Guild Settings (announcement channel + live role)
// ─────────────────────────────────────────────────────────────────────────────

async function configureGuild() {
  console.log('\n📋 Step 2: Setting guild announcement channel + live role...');

  await pool.execute(`
    INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      announcement_channel_id = VALUES(announcement_channel_id),
      live_role_id = VALUES(live_role_id)
  `, [GUILD_ID, ANNOUNCEMENT_CHANNEL_ID, LIVE_ROLE_ID]);

  console.log(`   ✅ Guild announcement channel: ${ANNOUNCEMENT_CHANNEL_ID}`);
  console.log(`   ✅ Guild live role: ${LIVE_ROLE_ID}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Configure Auto-Track (no role restriction)
// ─────────────────────────────────────────────────────────────────────────────

async function configureAutoTrack() {
  console.log('\n📋 Step 3: Setting up auto-track (no role restriction)...');

  await pool.execute(`
    INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, enabled)
    VALUES (?, NULL, ?, 1)
    ON DUPLICATE KEY UPDATE
      announcement_channel_id = VALUES(announcement_channel_id),
      enabled = 1
  `, [GUILD_ID, ANNOUNCEMENT_CHANNEL_ID]);

  console.log(`   ✅ Auto-track enabled for ALL members → ${ANNOUNCEMENT_CHANNEL_ID}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Add veryangryplatypus as Tracked Streamer
// ─────────────────────────────────────────────────────────────────────────────

async function addPlatypus() {
  console.log('\n📋 Step 4: Adding veryangryplatypus as tracked streamer...');

  const twitchUsername = 'veryangryplatypus';
  const twitchUser = await getTwitchUser(twitchUsername);

  if (!twitchUser) {
    console.log(`   ⚠️ Could not find Twitch user "${twitchUsername}" via API, inserting manually...`);

    // Insert streamer manually without platform_user_id
    const [existing] = await pool.execute(
      'SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?',
      ['twitch', twitchUsername]
    );

    let streamerId;
    if (existing.length > 0) {
      streamerId = existing[0].streamer_id;
      console.log(`   Streamer already exists (ID: ${streamerId})`);
    } else {
      const [result] = await pool.execute(
        'INSERT INTO streamers (username, platform) VALUES (?, ?)',
        [twitchUsername, 'twitch']
      );
      streamerId = result.insertId;
      console.log(`   ✅ Streamer created manually (ID: ${streamerId})`);
    }

    await insertSubscription(streamerId);
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

  await insertSubscription(streamerId);
}

async function insertSubscription(streamerId) {
  const [existingSub] = await pool.execute(
    'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
    [GUILD_ID, streamerId]
  );

  if (existingSub.length > 0) {
    console.log(`   Subscription already exists (ID: ${existingSub[0].subscription_id})`);
  } else {
    const [subResult] = await pool.execute(
      'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?, ?)',
      [GUILD_ID, streamerId, ANNOUNCEMENT_CHANNEL_ID, LIVE_ROLE_ID]
    );
    console.log(`   ✅ Subscription created (ID: ${subResult.insertId}) → channel ${ANNOUNCEMENT_CHANNEL_ID}, live role ${LIVE_ROLE_ID}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Hummus Nation (1475096615940521994) — Streaming Setup');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    await registerBot();
    await configureGuild();
    await configureAutoTrack();
    await addPlatypus();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(' ✅ Streaming setup complete!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\nNext steps:');
    console.log('  pm2 restart CertiFriedUtility');
    console.log('\nVerify:');
    console.log('  1. Bot loads as Hummus Nation in guild');
    console.log('  2. veryangryplatypus appears in subscriptions');
    console.log('  3. Auto-track enabled for all members (no role restriction)');
    console.log('  4. Live role assigned when streamers go live');
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    console.error(error.stack);
  }

  await pool.end();
  process.exit(0);
}

main();
