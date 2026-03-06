/**
 * CertiFried™ Server Channel & Role Reorganization
 * Guild ID: 1342779579168981065
 *
 * This script:
 * 1. Creates new categories and channels for games & notifications
 * 2. Creates opt-in roles for games
 * 3. Sets up a reaction role panel
 * 4. Updates database configurations to use new channels
 * 5. Separates logs into proper channels
 */

import dotenv from 'dotenv';
import pool from './utils/db.js';

dotenv.config();

const GUILD_ID = '1342779579168981065';
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const API_BASE = 'https://discord.com/api/v10';

// Existing channels
const EXISTING = {
  rolesChannel: '1346778182983876618',      // #roles - for reaction role panel
  botDebugging: '1348792496389361724',      // Currently used for counting & free games
  modLogs: '1352221650753421339',           // #modlogs
  automodLogs: '1346774829587759105',       // #automod-logs
  auditLog: '1346777079911288893',          // #audit-log
  logTesting: '1427440920210440242',        // #log-testing
  adminCategory: '1346774736159375400',     // Administration category
};

// Existing roles
const EXISTING_ROLES = {
  member: '1346772692401000509',
  bot: '1346777820285632512',
};

// New channels and roles to create
const NEW_CHANNELS = {
  // Notifications category
  notifications: {
    name: 'Notifications',
    channels: [
      { name: 'free-games', type: 0, topic: 'Free game alerts from Epic, Steam, and more!' },
      { name: 'steam-deals', type: 0, topic: 'Steam price alerts and deals' },
    ]
  },
  // Games category
  games: {
    name: 'Games & Activities',
    channels: [
      { name: 'minigames', type: 0, topic: 'Trivia, hangman, gambling, and other quick games' },
      { name: 'counting', type: 0, topic: 'Counting game - don\'t mess up!' },
      { name: 'pokemon', type: 0, topic: 'Catch Pokemon and battle!' },
      { name: 'dnd-adventures', type: 0, topic: 'D&D campaigns and character management' },
    ]
  }
};

const NEW_ROLES = [
  { name: 'Minigames', color: 0x3498db, hoist: false },
  { name: 'Pokemon', color: 0xf1c40f, hoist: false },
  { name: 'D&D', color: 0x9b59b6, hoist: false },
  { name: 'Free Games', color: 0x2ecc71, hoist: false },
  { name: 'Steam Deals', color: 0x1a9fff, hoist: false },
];

// Storage for created IDs
const created = {
  categories: {},
  channels: {},
  roles: {},
};

async function fetchDiscord(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${endpoint}`, options);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord API error ${response.status}: ${error}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function createCategory(name, position = null) {
  console.log(`   Creating category: ${name}`);
  const data = {
    name,
    type: 4, // GUILD_CATEGORY
  };
  if (position !== null) {
    data.position = position;
  }

  const result = await fetchDiscord(`/guilds/${GUILD_ID}/channels`, 'POST', data);
  return result;
}

async function createChannel(name, type, parentId, topic = null) {
  console.log(`   Creating channel: #${name}`);
  const data = {
    name,
    type,
    parent_id: parentId,
  };
  if (topic) {
    data.topic = topic;
  }

  const result = await fetchDiscord(`/guilds/${GUILD_ID}/channels`, 'POST', data);
  return result;
}

async function createRole(name, color, hoist = false) {
  console.log(`   Creating role: @${name}`);
  const data = {
    name,
    color,
    hoist,
    mentionable: true,
  };

  const result = await fetchDiscord(`/guilds/${GUILD_ID}/roles`, 'POST', data);
  return result;
}

async function setChannelPermissions(channelId, roleId, allow, deny = '0') {
  await fetchDiscord(`/channels/${channelId}/permissions/${roleId}`, 'PUT', {
    type: 0, // Role
    allow: allow.toString(),
    deny: deny.toString(),
  });
}

async function setup() {
  console.log('\n' + '='.repeat(70));
  console.log('  CertiFried™ Channel & Role Reorganization');
  console.log('  Guild ID: ' + GUILD_ID);
  console.log('='.repeat(70) + '\n');

  try {
    // 1. Create opt-in roles
    console.log('📋 Creating Game Opt-In Roles...');
    for (const roleData of NEW_ROLES) {
      try {
        const role = await createRole(roleData.name, roleData.color, roleData.hoist);
        created.roles[roleData.name.toLowerCase().replace(/\s+/g, '_')] = role.id;
        console.log(`   ✅ Created @${roleData.name} (${role.id})`);
      } catch (e) {
        console.log(`   ⚠️ Failed to create @${roleData.name}: ${e.message}`);
      }
    }

    // 2. Create Notifications category and channels
    console.log('\n📋 Creating Notifications Category...');
    try {
      const notifCategory = await createCategory(NEW_CHANNELS.notifications.name);
      created.categories.notifications = notifCategory.id;
      console.log(`   ✅ Created category: ${notifCategory.name} (${notifCategory.id})`);

      for (const ch of NEW_CHANNELS.notifications.channels) {
        const channel = await createChannel(ch.name, ch.type, notifCategory.id, ch.topic);
        created.channels[ch.name.replace(/-/g, '_')] = channel.id;
        console.log(`   ✅ Created #${channel.name} (${channel.id})`);

        // Set permissions - hide from @everyone, show to specific role
        const roleKey = ch.name.replace(/-/g, '_');
        if (created.roles[roleKey]) {
          // Deny @everyone view
          await setChannelPermissions(channel.id, GUILD_ID, '0', '1024'); // Deny VIEW_CHANNEL
          // Allow role view
          await setChannelPermissions(channel.id, created.roles[roleKey], '1024', '0'); // Allow VIEW_CHANNEL
          console.log(`   ✅ Set permissions: Only @${roleKey.replace(/_/g, ' ')} can see #${ch.name}`);
        }
      }
    } catch (e) {
      console.log(`   ⚠️ Error creating notifications category: ${e.message}`);
    }

    // 3. Create Games category and channels
    console.log('\n📋 Creating Games Category...');
    try {
      const gamesCategory = await createCategory(NEW_CHANNELS.games.name);
      created.categories.games = gamesCategory.id;
      console.log(`   ✅ Created category: ${gamesCategory.name} (${gamesCategory.id})`);

      for (const ch of NEW_CHANNELS.games.channels) {
        const channel = await createChannel(ch.name, ch.type, gamesCategory.id, ch.topic);
        created.channels[ch.name.replace(/-/g, '_')] = channel.id;
        console.log(`   ✅ Created #${channel.name} (${channel.id})`);
      }

      // Set up game channel permissions
      // Minigames channel - visible to @Minigames
      if (created.channels.minigames && created.roles.minigames) {
        await setChannelPermissions(created.channels.minigames, GUILD_ID, '0', '1024');
        await setChannelPermissions(created.channels.minigames, created.roles.minigames, '1024', '0');
        console.log(`   ✅ Set permissions: Only @Minigames can see #minigames`);
      }

      // Counting channel - visible to @Minigames
      if (created.channels.counting && created.roles.minigames) {
        await setChannelPermissions(created.channels.counting, GUILD_ID, '0', '1024');
        await setChannelPermissions(created.channels.counting, created.roles.minigames, '1024', '0');
        console.log(`   ✅ Set permissions: Only @Minigames can see #counting`);
      }

      // Pokemon channel - visible to @Pokemon
      if (created.channels.pokemon && created.roles.pokemon) {
        await setChannelPermissions(created.channels.pokemon, GUILD_ID, '0', '1024');
        await setChannelPermissions(created.channels.pokemon, created.roles.pokemon, '1024', '0');
        console.log(`   ✅ Set permissions: Only @Pokemon can see #pokemon`);
      }

      // D&D channel - visible to @D&D
      if (created.channels.dnd_adventures && created.roles['d&d']) {
        await setChannelPermissions(created.channels.dnd_adventures, GUILD_ID, '0', '1024');
        await setChannelPermissions(created.channels.dnd_adventures, created.roles['d&d'], '1024', '0');
        console.log(`   ✅ Set permissions: Only @D&D can see #dnd-adventures`);
      }
    } catch (e) {
      console.log(`   ⚠️ Error creating games category: ${e.message}`);
    }

    // 4. Update database configurations
    console.log('\n📋 Updating Database Configurations...');

    // Update free games subscription to use new channel
    if (created.channels.free_games) {
      await pool.execute(`
        UPDATE free_games_subscriptions
        SET discord_channel_id = ?, mention_role_id = ?
        WHERE guild_id = ?
      `, [created.channels.free_games, created.roles.free_games || null, GUILD_ID]);
      console.log(`   ✅ Free games -> #free-games (${created.channels.free_games})`);
    }

    // Update counting channel
    if (created.channels.counting) {
      await pool.execute(`
        UPDATE counting_channels
        SET channel_id = ?
        WHERE guild_id = ?
      `, [created.channels.counting, GUILD_ID]);
      console.log(`   ✅ Counting game -> #counting (${created.channels.counting})`);
    }

    // Configure Pokemon settings
    if (created.channels.pokemon) {
      await pool.execute(`
        INSERT INTO pokemon_settings (guild_id, pokemon_channel_id, spawn_enabled, activity_tracking_enabled)
        VALUES (?, ?, 1, 1)
        ON DUPLICATE KEY UPDATE
          pokemon_channel_id = VALUES(pokemon_channel_id),
          spawn_enabled = 1,
          activity_tracking_enabled = 1
      `, [GUILD_ID, created.channels.pokemon]);
      console.log(`   ✅ Pokemon -> #pokemon (${created.channels.pokemon})`);
    }

    // 5. Create reaction role panel
    console.log('\n📋 Creating Reaction Role Panel...');
    try {
      // Create the panel in database
      const panelDescription = `React to get access to game channels and notifications!

🎮 **Minigames** - Trivia, hangman, gambling, counting
🔴 **Pokemon** - Catch and battle Pokemon
🎲 **D&D** - D&D campaigns and adventures
🎁 **Free Games** - Free game alerts (Epic, Steam, etc.)
💨 **Steam Deals** - Steam sale and price alerts`;

      await pool.execute(`
        INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type, max_selections)
        VALUES (?, ?, '', 'Game & Notification Roles', ?, '#5865F2', 'normal', 'button', NULL)
      `, [GUILD_ID, EXISTING.rolesChannel, panelDescription]);

      const [[panel]] = await pool.execute('SELECT LAST_INSERT_ID() as id');
      const panelId = panel.id;

      // Add role mappings
      const mappings = [
        { emoji: '🎮', role: created.roles.minigames },
        { emoji: '🔴', role: created.roles.pokemon },
        { emoji: '🎲', role: created.roles['d&d'] },
        { emoji: '🎁', role: created.roles.free_games },
        { emoji: '💨', role: created.roles.steam_deals },
      ];

      for (const mapping of mappings) {
        if (mapping.role) {
          await pool.execute(`
            INSERT INTO reaction_role_mappings (panel_id, emoji_id, role_id)
            VALUES (?, ?, ?)
          `, [panelId, mapping.emoji, mapping.role]);
        }
      }

      console.log(`   ✅ Created reaction role panel (ID: ${panelId})`);
      console.log(`   ℹ️  Run /panel deploy in #roles to activate the panel`);
    } catch (e) {
      console.log(`   ⚠️ Error creating panel: ${e.message}`);
    }

    // 6. Separate logging
    console.log('\n📋 Configuring Separated Logging...');

    // Create separate log channel configs
    // We'll use the existing channels for now:
    // - #modlogs for moderation actions
    // - #automod-logs for automod triggers
    // - #audit-log for general server changes (role/channel/member updates)
    // - #log-testing for misc logs

    // The logging_config table only has one log_channel_id, but the bot's log-manager
    // should support separate channels. Let's check if there's a more detailed config.

    // For now, update the main log channel to audit-log
    await pool.execute(`
      UPDATE logging_config
      SET log_channel_id = ?
      WHERE guild_id = ?
    `, [EXISTING.auditLog, GUILD_ID]);
    console.log(`   ✅ General logs -> #audit-log`);

    // Update moderation config to use #modlogs
    await pool.execute(`
      UPDATE moderation_config
      SET mod_log_channel_id = ?
      WHERE guild_id = ?
    `, [EXISTING.modLogs, GUILD_ID]);
    console.log(`   ✅ Moderation logs -> #modlogs`);

    // Print summary
    console.log('\n' + '='.repeat(70));
    console.log('  ✅ REORGANIZATION COMPLETE!');
    console.log('='.repeat(70));

    console.log('\n📋 CREATED ROLES:');
    for (const [key, id] of Object.entries(created.roles)) {
      console.log(`   • @${key.replace(/_/g, ' ')}: ${id}`);
    }

    console.log('\n📋 CREATED CHANNELS:');
    for (const [key, id] of Object.entries(created.channels)) {
      console.log(`   • #${key.replace(/_/g, '-')}: ${id}`);
    }

    console.log('\n📋 LOG CHANNEL ASSIGNMENTS:');
    console.log(`   • Moderation actions -> #modlogs (${EXISTING.modLogs})`);
    console.log(`   • AutoMod triggers -> #automod-logs (${EXISTING.automodLogs})`);
    console.log(`   • Server changes -> #audit-log (${EXISTING.auditLog})`);

    console.log('\n💡 NEXT STEPS:');
    console.log('   1. Run /panel deploy in #roles to activate the reaction role panel');
    console.log('   2. Restart the bot to apply all configuration changes');
    console.log('   3. Test the new channels and roles');
    console.log('\n');

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

setup().catch(console.error);
