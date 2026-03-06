import pool from './utils/db.js';
import dotenv from 'dotenv';
dotenv.config();

const GUILD_ID = '1342779579168981065';

async function verifySetup() {
  console.log('\n' + '='.repeat(70));
  console.log('  VERIFICATION REPORT - Guild: ' + GUILD_ID);
  console.log('='.repeat(70) + '\n');

  try {
    // 1. Check moderation config
    const [modConfig] = await pool.execute('SELECT * FROM moderation_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('1. Moderation Config:', modConfig.length > 0 ? '✅ Configured' : '❌ Missing');
    if (modConfig.length > 0) {
      console.log(`   Log Channel: ${modConfig[0].mod_log_channel_id}`);
      console.log(`   Muted Role: ${modConfig[0].muted_role_id}`);
    }

    // 2. Check automod rules
    const [automodRules] = await pool.execute('SELECT filter_type, action, is_enabled FROM automod_rules WHERE guild_id = ?', [GUILD_ID]);
    console.log(`\n2. AutoMod Rules: ${automodRules.length} rule(s) configured`);
    automodRules.forEach(r => {
      console.log(`   • ${r.filter_type}: ${r.is_enabled ? '✅ enabled' : '❌ disabled'} (action: ${r.action})`);
    });

    // 3. Check heat config
    const [heatConfig] = await pool.execute('SELECT * FROM automod_heat_config WHERE guild_id = ?', [GUILD_ID]);
    console.log(`\n3. Heat System:`, heatConfig.length > 0 && heatConfig[0].is_enabled ? '✅ Enabled' : '❌ Disabled');
    if (heatConfig.length > 0) {
      console.log(`   Decay: ${heatConfig[0].decay_minutes} minutes`);
    }

    // 4. Check spam config
    const [spamConfig] = await pool.execute('SELECT * FROM automod_spam_config WHERE guild_id = ?', [GUILD_ID]);
    console.log(`\n4. Spam Detection:`, spamConfig.length > 0 && spamConfig[0].enabled ? '✅ Enabled' : '❌ Disabled');
    if (spamConfig.length > 0) {
      console.log(`   Max messages: ${spamConfig[0].max_messages}/${spamConfig[0].time_window}sec`);
    }

    // 5. Check escalation rules
    const [escalation] = await pool.execute('SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count', [GUILD_ID]);
    console.log(`\n5. Escalation Rules: ${escalation.length} rule(s) configured`);
    escalation.forEach(r => {
      console.log(`   • ${r.infraction_count} infractions in ${r.time_period_hours}h = ${r.action}${r.action_duration_minutes ? ` (${r.action_duration_minutes}min)` : ''}`);
    });

    // 6. Check anti-nuke
    const [antiNuke] = await pool.execute('SELECT * FROM anti_nuke_config WHERE guild_id = ?', [GUILD_ID]);
    console.log(`\n6. Anti-Nuke Protection:`, antiNuke.length > 0 && antiNuke[0].enabled ? '✅ Enabled' : '❌ Disabled');
    if (antiNuke.length > 0) {
      console.log(`   Max channel/role deletes: ${antiNuke[0].max_channel_deletes}/${antiNuke[0].max_role_deletes}`);
      console.log(`   Max kick/bans: ${antiNuke[0].max_kick_bans}`);
      console.log(`   Action: ${antiNuke[0].action_on_trigger}`);
    }

    // 7. Check raid detection
    const [raidDetection] = await pool.execute('SELECT * FROM raid_detection_config WHERE guild_id = ?', [GUILD_ID]);
    console.log(`\n7. Raid Detection:`, raidDetection.length > 0 && raidDetection[0].enabled ? '✅ Enabled' : '❌ Disabled');
    if (raidDetection.length > 0) {
      console.log(`   Join threshold: ${raidDetection[0].join_threshold} joins in ${raidDetection[0].join_timeframe_seconds}sec`);
      console.log(`   New account age: ${raidDetection[0].new_account_age_hours}h`);
    }

    // 8. Check adaptive spam
    const [adaptiveSpam] = await pool.execute('SELECT * FROM adaptive_spam_config WHERE guild_id = ?', [GUILD_ID]);
    console.log(`\n8. Adaptive Spam:`, adaptiveSpam.length > 0 && adaptiveSpam[0].enabled ? '✅ Enabled' : '❌ Disabled');
    if (adaptiveSpam.length > 0) {
      console.log(`   Cross-channel threshold: ${adaptiveSpam[0].cross_channel_threshold} channels in ${adaptiveSpam[0].cross_channel_timeframe_minutes}min`);
    }

    // 9. Check selfbot detection
    const [selfbot] = await pool.execute('SELECT * FROM selfbot_detection_config WHERE guild_id = ?', [GUILD_ID]);
    console.log(`\n9. Selfbot Detection:`, selfbot.length > 0 && selfbot[0].enabled ? '✅ Enabled' : '❌ Disabled');
    if (selfbot.length > 0) {
      console.log(`   Burst threshold: ${selfbot[0].message_burst_threshold} msgs/${selfbot[0].message_burst_window_ms}ms`);
    }

    // 10. Check logging config
    const [logging] = await pool.execute('SELECT * FROM logging_config WHERE guild_id = ?', [GUILD_ID]);
    console.log(`\n10. Logging:`, logging.length > 0 ? '✅ Configured' : '❌ Not configured');
    if (logging.length > 0) {
      console.log(`    Channel: ${logging[0].log_channel_id}`);
      const events = JSON.parse(logging[0].enabled_events || '[]');
      console.log(`    Enabled events: ${events.length}`);
    }

    console.log('\n' + '='.repeat(70));
    console.log('  VERIFICATION COMPLETE');
    console.log('='.repeat(70) + '\n');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

verifySetup();
