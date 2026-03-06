import dotenv from 'dotenv';
import pool from './utils/db.js';

dotenv.config();

const GUILD_ID = '1342779579168981065';
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const API_BASE = 'https://discord.com/api/v10';

async function fetchDiscord(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Authorization': `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord API error ${response.status}: ${error}`);
  }

  return response.json();
}

async function inspectServer() {
  console.log('\n' + '='.repeat(80));
  console.log('  SERVER INSPECTION REPORT');
  console.log('  Guild ID: ' + GUILD_ID);
  console.log('='.repeat(80) + '\n');

  try {
    // Fetch guild info
    const guild = await fetchDiscord(`/guilds/${GUILD_ID}?with_counts=true`);

    console.log('\n### BASIC SERVER INFORMATION ###');
    console.log(`Name: ${guild.name}`);
    console.log(`Owner ID: ${guild.owner_id}`);
    console.log(`Approximate Member Count: ${guild.approximate_member_count}`);
    console.log(`Approximate Presence Count: ${guild.approximate_presence_count}`);
    console.log(`Verification Level: ${guild.verification_level}`);
    console.log(`Explicit Content Filter: ${guild.explicit_content_filter}`);
    console.log(`Default Notifications: ${guild.default_message_notifications}`);
    console.log(`MFA Level: ${guild.mfa_level}`);
    console.log(`NSFW Level: ${guild.nsfw_level}`);
    console.log(`Premium Tier: ${guild.premium_tier}`);
    console.log(`Premium Subscribers: ${guild.premium_subscription_count}`);
    console.log(`Features: ${guild.features.join(', ') || 'None'}`);

    // Fetch channels
    const channels = await fetchDiscord(`/guilds/${GUILD_ID}/channels`);

    console.log('\n### CHANNELS ###');
    const categories = channels.filter(c => c.type === 4); // GUILD_CATEGORY
    const textChannels = channels.filter(c => c.type === 0); // GUILD_TEXT
    const voiceChannels = channels.filter(c => c.type === 2); // GUILD_VOICE
    const forumChannels = channels.filter(c => c.type === 15); // GUILD_FORUM
    const stageChannels = channels.filter(c => c.type === 13); // GUILD_STAGE_VOICE
    const announcementChannels = channels.filter(c => c.type === 5); // GUILD_ANNOUNCEMENT

    console.log(`Total Channels: ${channels.length}`);
    console.log(`  Categories: ${categories.length}`);
    console.log(`  Text Channels: ${textChannels.length}`);
    console.log(`  Voice Channels: ${voiceChannels.length}`);
    console.log(`  Forum Channels: ${forumChannels.length}`);
    console.log(`  Stage Channels: ${stageChannels.length}`);
    console.log(`  Announcement Channels: ${announcementChannels.length}`);

    console.log('\n--- Channel Structure ---');

    // Group by category
    const uncategorized = channels.filter(c => !c.parent_id && c.type !== 4);

    if (uncategorized.length > 0) {
      console.log('\n[No Category]');
      uncategorized.sort((a, b) => a.position - b.position).forEach(ch => {
        console.log(`  ${getChannelIcon(ch.type)} ${ch.name} (${ch.id})`);
      });
    }

    categories.sort((a, b) => a.position - b.position).forEach(cat => {
      console.log(`\n[${cat.name}] (${cat.id})`);
      const childChannels = channels.filter(c => c.parent_id === cat.id);
      childChannels.sort((a, b) => a.position - b.position).forEach(ch => {
        console.log(`  ${getChannelIcon(ch.type)} ${ch.name} (${ch.id})`);
      });
    });

    // Fetch roles
    const roles = await fetchDiscord(`/guilds/${GUILD_ID}/roles`);

    console.log('\n### ROLES ###');
    console.log(`Total Roles: ${roles.length}`);
    console.log('\n--- Role Hierarchy (Top to Bottom) ---');

    roles.sort((a, b) => b.position - a.position).forEach(role => {
      const perms = BigInt(role.permissions);
      const permList = [];

      if ((perms & BigInt(0x8)) !== 0n) permList.push('ADMIN');
      if ((perms & BigInt(0x20)) !== 0n) permList.push('ManageServer');
      if ((perms & BigInt(0x10)) !== 0n) permList.push('ManageChannels');
      if ((perms & BigInt(0x10000000)) !== 0n) permList.push('ManageRoles');
      if ((perms & BigInt(0x4)) !== 0n) permList.push('Ban');
      if ((perms & BigInt(0x2)) !== 0n) permList.push('Kick');
      if ((perms & BigInt(0x10000000000)) !== 0n) permList.push('Timeout');
      if ((perms & BigInt(0x2000)) !== 0n) permList.push('ManageMsg');

      const permStr = permList.length > 0 ? ` [${permList.join(', ')}]` : '';
      const managed = role.managed ? ' (Bot/Integration)' : '';
      const color = role.color ? ` #${role.color.toString(16).padStart(6, '0')}` : '';
      console.log(`  ${role.position}. ${role.name} (${role.id})${color}${permStr}${managed}`);
    });

    // Discord's AutoMod rules
    console.log('\n### DISCORD AUTOMOD RULES ###');
    try {
      const automodRules = await fetchDiscord(`/guilds/${GUILD_ID}/auto-moderation/rules`);
      if (automodRules.length > 0) {
        automodRules.forEach(rule => {
          console.log(`\n  Rule: ${rule.name} (${rule.id})`);
          console.log(`    Enabled: ${rule.enabled}`);
          console.log(`    Trigger Type: ${rule.trigger_type}`);
          console.log(`    Event Type: ${rule.event_type}`);
          console.log(`    Actions: ${rule.actions.map(a => a.type).join(', ')}`);
          if (rule.trigger_metadata) {
            console.log(`    Trigger Metadata: ${JSON.stringify(rule.trigger_metadata)}`);
          }
        });
      } else {
        console.log('  No Discord AutoMod rules configured');
      }
    } catch (error) {
      console.log('  Could not fetch AutoMod rules:', error.message);
    }

    // System channels
    console.log('\n### SYSTEM CHANNELS ###');
    const systemChannel = channels.find(c => c.id === guild.system_channel_id);
    const rulesChannel = channels.find(c => c.id === guild.rules_channel_id);
    const publicUpdatesChannel = channels.find(c => c.id === guild.public_updates_channel_id);
    const afkChannel = channels.find(c => c.id === guild.afk_channel_id);

    console.log(`System Channel: ${systemChannel ? `#${systemChannel.name} (${guild.system_channel_id})` : 'Not set'}`);
    console.log(`Rules Channel: ${rulesChannel ? `#${rulesChannel.name} (${guild.rules_channel_id})` : 'Not set'}`);
    console.log(`Public Updates Channel: ${publicUpdatesChannel ? `#${publicUpdatesChannel.name} (${guild.public_updates_channel_id})` : 'Not set'}`);
    console.log(`AFK Channel: ${afkChannel ? `#${afkChannel.name} (${guild.afk_channel_id})` : 'Not set'}`);
    console.log(`AFK Timeout: ${guild.afk_timeout} seconds`);

  } catch (error) {
    console.log('Discord API error:', error.message);
  }

  // Database configurations
  console.log('\n### DATABASE CONFIGURATIONS ###');

  try {
    // Guild config
    const [guildConfig] = await pool.execute('SELECT * FROM guild_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Guild Config ---');
    console.log(guildConfig.length > 0 ? JSON.stringify(guildConfig[0], null, 2) : 'Not configured');

    // Welcome settings
    const [welcomeSettings] = await pool.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Welcome Settings ---');
    console.log(welcomeSettings.length > 0 ? JSON.stringify(welcomeSettings[0], null, 2) : 'Not configured');

    // Logging config
    const [loggingConfig] = await pool.execute('SELECT * FROM logging_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Logging Config ---');
    console.log(loggingConfig.length > 0 ? JSON.stringify(loggingConfig[0], null, 2) : 'Not configured');

    // Moderation config
    const [modConfig] = await pool.execute('SELECT * FROM moderation_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Moderation Config ---');
    console.log(modConfig.length > 0 ? JSON.stringify(modConfig[0], null, 2) : 'Not configured');

    // AutoMod rules
    const [automodRules] = await pool.execute('SELECT * FROM automod_rules WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Bot AutoMod Rules ---');
    console.log(automodRules.length > 0 ? JSON.stringify(automodRules, null, 2) : 'No rules configured');

    // AutoMod heat config
    const [heatConfig] = await pool.execute('SELECT * FROM automod_heat_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- AutoMod Heat Config ---');
    console.log(heatConfig.length > 0 ? JSON.stringify(heatConfig[0], null, 2) : 'Not configured');

    // AutoMod spam config
    const [spamConfig] = await pool.execute('SELECT * FROM automod_spam_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- AutoMod Spam Config ---');
    console.log(spamConfig.length > 0 ? JSON.stringify(spamConfig[0], null, 2) : 'Not configured');

    // Join gate config
    const [joinGate] = await pool.execute('SELECT * FROM join_gate_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Join Gate Config ---');
    console.log(joinGate.length > 0 ? JSON.stringify(joinGate[0], null, 2) : 'Not configured');

    // Temp channel config
    const [tempChannels] = await pool.execute('SELECT * FROM temp_channel_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Temp Channel Config ---');
    console.log(tempChannels.length > 0 ? JSON.stringify(tempChannels[0], null, 2) : 'Not configured');

    // Escalation rules
    const [escalation] = await pool.execute('SELECT * FROM escalation_rules WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Escalation Rules ---');
    console.log(escalation.length > 0 ? JSON.stringify(escalation, null, 2) : 'No rules configured');

    // Reaction roles
    const [reactionRoles] = await pool.execute('SELECT * FROM reaction_role_panels WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Reaction Role Panels ---');
    console.log(reactionRoles.length > 0 ? `${reactionRoles.length} panel(s) configured` : 'Not configured');

    // Check for anti-nuke, raid detection configs
    try {
      const [antiNuke] = await pool.execute('SELECT * FROM anti_nuke_config WHERE guild_id = ?', [GUILD_ID]);
      console.log('\n--- Anti-Nuke Config ---');
      console.log(antiNuke.length > 0 ? JSON.stringify(antiNuke[0], null, 2) : 'Not configured');
    } catch (e) {
      console.log('\n--- Anti-Nuke Config ---');
      console.log('Table not found');
    }

    try {
      const [raidDetection] = await pool.execute('SELECT * FROM raid_detection_config WHERE guild_id = ?', [GUILD_ID]);
      console.log('\n--- Raid Detection Config ---');
      console.log(raidDetection.length > 0 ? JSON.stringify(raidDetection[0], null, 2) : 'Not configured');
    } catch (e) {
      console.log('\n--- Raid Detection Config ---');
      console.log('Table not found');
    }

    // Tickets
    const [ticketConfig] = await pool.execute('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Tickets ---');
    console.log(`Total tickets: ${ticketConfig[0].count}`);

    // Infractions
    const [infractions] = await pool.execute('SELECT COUNT(*) as count FROM infractions WHERE guild_id = ?', [GUILD_ID]);
    console.log('\n--- Infractions ---');
    console.log(`Total infractions: ${infractions[0].count}`);

  } catch (error) {
    console.log('Database error:', error.message);
  }

  console.log('\n' + '='.repeat(80));
  console.log('  END OF INSPECTION REPORT');
  console.log('='.repeat(80) + '\n');

  await pool.end();
}

function getChannelIcon(type) {
  switch (type) {
    case 0: return '#';      // GUILD_TEXT
    case 2: return '🔊';     // GUILD_VOICE
    case 4: return '📁';     // GUILD_CATEGORY
    case 5: return '📢';     // GUILD_ANNOUNCEMENT
    case 13: return '🎤';    // GUILD_STAGE_VOICE
    case 15: return '💬';    // GUILD_FORUM
    case 16: return '🖼️';    // GUILD_MEDIA
    default: return '?';
  }
}

inspectServer().catch(console.error);
