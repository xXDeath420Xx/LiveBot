/**
 * CertiFried™ Server Security Setup
 * Guild ID: 1342779579168981065
 *
 * This script configures moderate security settings for the server.
 * Run with: node setup-server-security.js
 */

import dotenv from 'dotenv';
import pool from './utils/db.js';

dotenv.config();

const GUILD_ID = '1342779579168981065';

// Channel IDs from inspection
const CHANNELS = {
  modLogs: '1352221650753421339',          // #modlogs - for mod actions
  automodLogs: '1346774829587759105',      // #automod-logs - for automod
  auditLog: '1346777079911288893',         // #audit-log
  logTesting: '1427440920210440242',       // #log-testing - general logging
  welcomeChannel: '1346784639569887232',   // #new-faces
  rulesChannel: '1346778145285734400',     // #welcome (rules)
  general: '1342779580099985459',          // #general
  moderatorOnly: '1346774225402204163'     // #moderator-only
};

// Role IDs from inspection
const ROLES = {
  admin: '1346779148944937010',
  moderator: '1346772799162941510',
  vip: '1346772873141813269',
  contentCreator: '1346772580425531392',
  member: '1346772692401000509',
  muted: '1346776321019215922',
  quarantine: '1352221606436405298',
  nsfw: '1347106530645774378',
  bot: '1346777820285632512'
};

async function setupServer() {
  console.log('\n' + '='.repeat(70));
  console.log('  CertiFried™ Server Security Setup');
  console.log('  Guild ID: ' + GUILD_ID);
  console.log('='.repeat(70) + '\n');

  try {
    // 1. Setup Moderation Config
    console.log('📋 Configuring Moderation Settings...');
    await pool.execute(`
      INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
        mod_log_channel_id = VALUES(mod_log_channel_id),
        muted_role_id = VALUES(muted_role_id)
    `, [GUILD_ID, CHANNELS.modLogs, ROLES.muted]);
    console.log('   ✅ Mod log channel set to #modlogs');
    console.log('   ✅ Muted role set to @Muted');

    // 2. Setup AutoMod Rules (Bot's custom automod)
    console.log('\n📋 Configuring Bot AutoMod Rules...');

    // First, clear existing rules for this guild
    await pool.execute('DELETE FROM automod_rules WHERE guild_id = ?', [GUILD_ID]);

    // 2a. Anti-Spam Rule
    await pool.execute(`
      INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
      VALUES (?, 'anti_spam', ?, 'mute', 5, 1, ?, ?)
    `, [
      GUILD_ID,
      JSON.stringify({
        message_threshold: 5,
        time_window_seconds: 5,
        duplicate_threshold: 3
      }),
      JSON.stringify([CHANNELS.moderatorOnly]),
      JSON.stringify([ROLES.admin, ROLES.moderator, ROLES.bot])
    ]);
    console.log('   ✅ Anti-spam rule: 5 messages in 5 seconds = 5min mute');

    // 2b. Discord Invites Rule
    await pool.execute(`
      INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
      VALUES (?, 'discord_invites', ?, 'warn', NULL, 1, ?, ?)
    `, [
      GUILD_ID,
      JSON.stringify({
        allow_own_server: true,
        allow_partnered: false,
        delete_message: true
      }),
      JSON.stringify([CHANNELS.moderatorOnly]),
      JSON.stringify([ROLES.admin, ROLES.moderator, ROLES.vip, ROLES.contentCreator])
    ]);
    console.log('   ✅ Discord invite filter: Block external invites (VIP+ exempt)');

    // 2c. Mass Mentions Rule
    await pool.execute(`
      INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
      VALUES (?, 'mass_mentions', ?, 'mute', 10, 1, ?, ?)
    `, [
      GUILD_ID,
      JSON.stringify({
        max_mentions: 5,
        max_role_mentions: 3,
        delete_message: true
      }),
      JSON.stringify([]),
      JSON.stringify([ROLES.admin, ROLES.moderator])
    ]);
    console.log('   ✅ Mass mentions rule: 5+ mentions = 10min mute');

    // 2d. All Caps Rule
    await pool.execute(`
      INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
      VALUES (?, 'all_caps', ?, 'warn', NULL, 1, ?, ?)
    `, [
      GUILD_ID,
      JSON.stringify({
        min_length: 10,
        caps_percentage: 70,
        delete_message: false
      }),
      JSON.stringify([CHANNELS.moderatorOnly]),
      JSON.stringify([ROLES.admin, ROLES.moderator])
    ]);
    console.log('   ✅ All caps rule: 70%+ caps in messages over 10 chars = warn');

    // 2e. Banned Words Rule (supplementary to Discord's built-in)
    await pool.execute(`
      INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
      VALUES (?, 'banned_words', ?, 'warn', NULL, 1, ?, ?)
    `, [
      GUILD_ID,
      JSON.stringify({
        words: ['n1gger', 'n1gga', 'f4ggot', 'f4g', 'k1ke', 'ch1nk', 'sp1c', 'tr4nny'],
        match_type: 'contains',
        delete_message: true
      }),
      JSON.stringify([]),
      JSON.stringify([])
    ]);
    console.log('   ✅ Banned words rule: Evasion-resistant slur filter');

    // 3. Setup AutoMod Heat Config (Progressive Punishment)
    console.log('\n📋 Configuring Heat-Based Progressive Punishment...');
    await pool.execute(`
      INSERT INTO automod_heat_config (guild_id, is_enabled, heat_values, decay_minutes, action_thresholds)
      VALUES (?, 1, ?, 15, ?)
      ON DUPLICATE KEY UPDATE
        is_enabled = 1,
        heat_values = VALUES(heat_values),
        decay_minutes = VALUES(decay_minutes),
        action_thresholds = VALUES(action_thresholds)
    `, [
      GUILD_ID,
      JSON.stringify({
        spam: 20,
        mention: 15,
        caps: 5,
        invite: 25,
        banned_word: 30,
        link: 10
      }),
      JSON.stringify({
        warn: 25,
        mute_5min: 50,
        mute_30min: 75,
        kick: 100,
        ban: 150
      })
    ]);
    console.log('   ✅ Heat system: Decays over 15 minutes');
    console.log('   ✅ Thresholds: 25=warn, 50=5min mute, 75=30min mute, 100=kick, 150=ban');

    // 4. Setup AutoMod Spam Config
    console.log('\n📋 Configuring Spam Detection...');
    await pool.execute(`
      INSERT INTO automod_spam_config (guild_id, time_window, max_messages, max_mentions, max_emojis, max_repeated_chars, action, enabled)
      VALUES (?, 5, 5, 5, 15, 15, 'mute', 1)
      ON DUPLICATE KEY UPDATE
        time_window = VALUES(time_window),
        max_messages = VALUES(max_messages),
        max_mentions = VALUES(max_mentions),
        max_emojis = VALUES(max_emojis),
        max_repeated_chars = VALUES(max_repeated_chars),
        action = VALUES(action),
        enabled = VALUES(enabled)
    `, [GUILD_ID]);
    console.log('   ✅ Spam config: 5msg/5sec, 5 mentions, 15 emojis, 15 repeated chars');

    // 5. Setup Escalation Rules (Progressive Punishment based on infractions)
    console.log('\n📋 Configuring Escalation Rules...');
    await pool.execute('DELETE FROM escalation_rules WHERE guild_id = ?', [GUILD_ID]);

    // 3 warns in 24h = 30min mute
    await pool.execute(`
      INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes)
      VALUES (?, 3, 24, 'mute', 30)
    `, [GUILD_ID]);
    console.log('   ✅ 3 infractions in 24h = 30min mute');

    // 5 warns in 48h = 2h mute
    await pool.execute(`
      INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes)
      VALUES (?, 5, 48, 'mute', 120)
    `, [GUILD_ID]);
    console.log('   ✅ 5 infractions in 48h = 2h mute');

    // 7 warns in 7 days = kick
    await pool.execute(`
      INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes)
      VALUES (?, 7, 168, 'kick', NULL)
    `, [GUILD_ID]);
    console.log('   ✅ 7 infractions in 7 days = kick');

    // 10 warns in 30 days = ban
    await pool.execute(`
      INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes)
      VALUES (?, 10, 720, 'ban', NULL)
    `, [GUILD_ID]);
    console.log('   ✅ 10 infractions in 30 days = ban');

    // 6. Setup Anti-Nuke Config
    console.log('\n📋 Configuring Anti-Nuke Protection...');

    await pool.execute(`
      INSERT INTO anti_nuke_config (
        guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans,
        action_on_trigger, alert_channel_id
      ) VALUES (?, 1, 3, 3, 5, 'kick', ?)
      ON DUPLICATE KEY UPDATE
        enabled = 1,
        max_channel_deletes = 3,
        max_role_deletes = 3,
        max_kick_bans = 5,
        action_on_trigger = 'kick',
        alert_channel_id = VALUES(alert_channel_id)
    `, [GUILD_ID, CHANNELS.modLogs]);
    console.log('   ✅ Anti-nuke: 3 channel/role deletes or 5 bans/kicks triggers kick');
    console.log('   ✅ Alerts sent to #modlogs');

    // 7. Setup Raid Detection Config
    console.log('\n📋 Configuring Raid Detection...');

    await pool.execute(`
      INSERT INTO raid_detection_config (
        guild_id, enabled, join_threshold, join_timeframe_seconds,
        new_account_age_hours, new_account_ratio, action,
        alert_channel_id, mute_duration_minutes, purge_messages
      ) VALUES (?, 1, 8, 60, 168, 0.70, 'alert', ?, 60, 0)
      ON DUPLICATE KEY UPDATE
        enabled = 1,
        join_threshold = 8,
        join_timeframe_seconds = 60,
        new_account_age_hours = 168,
        new_account_ratio = 0.70,
        action = 'alert',
        alert_channel_id = VALUES(alert_channel_id),
        mute_duration_minutes = 60,
        purge_messages = 0
    `, [GUILD_ID, CHANNELS.moderatorOnly]);
    console.log('   ✅ Raid detection: 8 joins in 60s triggers alert');
    console.log('   ✅ Accounts younger than 7 days (168h) flagged');
    console.log('   ✅ Alerts sent to #moderator-only');

    // 8. Setup Adaptive Spam Config (Sery Bot feature)
    console.log('\n📋 Configuring Adaptive Spam Detection...');

    await pool.execute(`
      INSERT INTO adaptive_spam_config (
        guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes,
        deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h,
        action, alert_channel_id
      ) VALUES (?, 1, 3, 5, 2.00, 1.50, 2.00, 'alert', ?)
      ON DUPLICATE KEY UPDATE
        enabled = 1,
        cross_channel_threshold = 3,
        cross_channel_timeframe_minutes = 5,
        deviation_multiplier = 2.00,
        new_account_multiplier_7d = 1.50,
        new_account_multiplier_24h = 2.00,
        action = 'alert',
        alert_channel_id = VALUES(alert_channel_id)
    `, [GUILD_ID, CHANNELS.modLogs]);
    console.log('   ✅ Adaptive spam: Cross-channel detection (3 channels in 5 min)');
    console.log('   ✅ New account sensitivity multipliers enabled');

    // 9. Setup Selfbot Detection Config
    console.log('\n📋 Configuring Selfbot Detection...');

    await pool.execute(`
      INSERT INTO selfbot_detection_config (
        guild_id, enabled, min_response_time_ms, message_burst_threshold,
        message_burst_window_ms, pattern_threshold, action,
        alert_channel_id, exempt_roles
      ) VALUES (?, 1, 50, 20, 1000, 3, 'alert', ?, ?)
      ON DUPLICATE KEY UPDATE
        enabled = 1,
        min_response_time_ms = 50,
        message_burst_threshold = 20,
        message_burst_window_ms = 1000,
        pattern_threshold = 3,
        action = 'alert',
        alert_channel_id = VALUES(alert_channel_id),
        exempt_roles = VALUES(exempt_roles)
    `, [
      GUILD_ID,
      CHANNELS.modLogs,
      JSON.stringify([ROLES.admin, ROLES.moderator, ROLES.bot])
    ]);
    console.log('   ✅ Selfbot detection: 20 msgs/sec burst threshold');
    console.log('   ✅ Response time < 50ms flagged as suspicious');

    // 10. Update logging config to use more specific channels
    console.log('\n📋 Updating Logging Configuration...');
    await pool.execute(`
      UPDATE logging_config
      SET log_channel_id = ?,
          enabled_events = ?
      WHERE guild_id = ?
    `, [
      CHANNELS.auditLog,  // Use #audit-log for general logs
      JSON.stringify([
        'messageDelete', 'messageUpdate', 'messageBulkDelete',
        'memberJoin', 'memberLeave', 'memberUpdate', 'memberKick', 'memberBan',
        'voiceUpdate',
        'channelCreate', 'channelDelete', 'channelUpdate',
        'threadCreate', 'threadDelete', 'threadUpdate',
        'guildUpdate',
        'ban', 'unban',
        'roleCreate', 'roleDelete', 'roleUpdate',
        'emojiCreate', 'emojiDelete', 'emojiUpdate',
        'webhookUpdate', 'integrationUpdate',
        'moderation', 'automod',
        'join-gate', 'system', 'xp', 'giveaway', 'poll',
        'starboard', 'sticky-roles', 'temp-channels',
        'tickets', 'team-sync'
      ]),
      GUILD_ID
    ]);
    console.log('   ✅ General logs -> #audit-log');

    console.log('\n' + '='.repeat(70));
    console.log('  ✅ SERVER SECURITY SETUP COMPLETE!');
    console.log('='.repeat(70));
    console.log('\n📋 SUMMARY OF CONFIGURATIONS:');
    console.log('   • Moderation logs: #modlogs (ID: ' + CHANNELS.modLogs + ')');
    console.log('   • Muted role: @Muted (ID: ' + ROLES.muted + ')');
    console.log('   • AutoMod rules: anti-spam, invites, mentions, caps, banned words');
    console.log('   • Heat system: Progressive punishment (25=warn, 50=mute, 100=kick, 150=ban)');
    console.log('   • Escalation: 3 warns=30min mute, 5 warns=2h mute, 7 warns=kick, 10 warns=ban');
    console.log('   • Anti-nuke: Protects against mass deletions/bans (kick action)');
    console.log('   • Raid detection: 8 joins/60s triggers alert to moderators');
    console.log('   • Adaptive spam: Cross-channel detection with new account sensitivity');
    console.log('   • Selfbot detection: Burst detection with 20 msgs/sec threshold');
    console.log('\n💡 RECOMMENDATIONS:');
    console.log('   1. Test AutoMod rules with alt accounts before going live');
    console.log('   2. Review #modlogs regularly for false positives');
    console.log('   3. Adjust heat thresholds if too strict/lenient');
    console.log('   4. Consider adding more banned words as needed');
    console.log('   5. Set up a verification panel for new members (optional)');
    console.log('   6. The bot must be restarted for config changes to take effect');
    console.log('\n');

  } catch (error) {
    console.error('❌ Error during setup:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

setupServer().catch(console.error);
