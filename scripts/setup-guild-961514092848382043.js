/**
 * Setup script for YYZ Studio guild (961514092848382043)
 * Configures all CertiFried features to replace former Mee6 setup.
 *
 * Features configured:
 *   1. Welcome messages + auto-role (Settler)
 *   2. Leveling system + level rewards
 *   3. Automod rules (spam, invites, mass mentions, caps, slurs)
 *   4. Protection suite (adaptive spam, raid, anti-nuke, selfbot)
 *   5. Logging
 *   6. Escalation rules
 *
 * Usage: node scripts/setup-guild-961514092848382043.js
 */
import dotenv from 'dotenv';
dotenv.config();

import pool, { transaction } from '../utils/db.js';

const GUILD_ID = '961514092848382043';

// ── Channel IDs (from discovery) ───────────────────────────────────────────
const ch = {
    welcome:       '1345459778855370872',  // #👋︱port
    rules:         '1345463245435179110',  // #📔︱rules
    roles:         '1345464357466804305',  // #🧬︱roles
    levels:        '1345560844129534043',  // #💪︱levels
    general:       '1345416615503597579',  // #💬︱general
    tickets:       '1345463513996328970',  // #📩︱tickets
    serverUpdates: '1345468489389047919',  // #📢︱server-updates
    // Staff channels
    allLogs:       '1345462542713094185',  // #all-logs (main mod log)
    spamLogs:      '1353853660807037022',  // #spam-logs
    joinLogs:      '1353857670410539131',  // #join-logs
    botCommands:   '1345483761277472881',  // #bot-commands
    staffGeneral:  '1345460274215391293',  // #staff-general
};

// ── Role IDs (from discovery) ──────────────────────────────────────────────
const r = {
    developer:        '1001536111979544576',
    admin:            '1352487753518157834',
    modPerms:         '1352488296495841340',
    moderator:        '993491706580320367',
    quarantine:       '1353899798071345244',
    // Level roles
    settler:          '1011022566493798500',   // Level 0 (auto-assign)
    advancedSettler:  '1345558370848870452',   // Level 5-9
    navigator:        '1345558730573484045',   // Level 10-14
    dockMaster:       '1345558582342582343',   // Level 15-20
    dockLord:         '1345558827533340703',   // Level 21+
};

const staffRoles = [r.developer, r.admin, r.modPerms, r.moderator];

async function setup() {
    console.log('Setting up YYZ Studio guild...\n');

    await transaction(async (conn) => {

        // ================================================================
        // 0. GUILD RECORD
        // ================================================================
        console.log('0/6  guilds...');
        await conn.execute(`
            INSERT INTO guilds (guild_id, guild_name, announcement_channel_id)
            VALUES (?, 'YYZ Studio', ?)
            ON DUPLICATE KEY UPDATE
                guild_name = VALUES(guild_name),
                announcement_channel_id = VALUES(announcement_channel_id)
        `, [GUILD_ID, ch.serverUpdates]);
        console.log('     ✓ Guild record (announcements → #📢︱server-updates)');

        // ================================================================
        // 1. WELCOME MESSAGES + AUTO-ROLE
        // ================================================================
        console.log('\n1/6  welcome_settings...');
        await conn.execute(`
            INSERT INTO welcome_settings (guild_id, channel_id, message, auto_role_id, banner_enabled, goodbye_enabled)
            VALUES (?, ?, ?, ?, 0, 0)
            ON DUPLICATE KEY UPDATE
                channel_id = VALUES(channel_id),
                message = VALUES(message),
                auto_role_id = VALUES(auto_role_id)
        `, [
            GUILD_ID,
            ch.welcome,
            'Welcome to **YYZ Studio**, {mention}! Head to <#' + ch.roles + '> to grab your game roles and check out <#' + ch.rules + '> for the community guidelines.',
            r.settler,
        ]);
        console.log('     ✓ Welcome → #👋︱port');
        console.log('     ✓ Auto-role → Settler');

        // ================================================================
        // 2. LEVELING SYSTEM + LEVEL REWARDS
        // ================================================================
        console.log('\n2/6  level_config + level_rewards...');
        await conn.execute(`
            INSERT INTO level_config
                (guild_id, enabled, xp_per_message, xp_cooldown_seconds,
                 xp_per_voice_minute, voice_xp_enabled,
                 level_up_message, level_up_channel_id)
            VALUES (?, 1, 20, 60, 5, 1, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                xp_per_message = 20,
                xp_cooldown_seconds = 60,
                xp_per_voice_minute = 5,
                voice_xp_enabled = 1,
                level_up_message = VALUES(level_up_message),
                level_up_channel_id = VALUES(level_up_channel_id)
        `, [
            GUILD_ID,
            'Congrats {user}! You reached **Level {level}**!',
            ch.levels,
        ]);
        console.log('     ✓ Leveling enabled (20 XP/msg, 60s cooldown, 5 XP/voice min)');
        console.log('     ✓ Level-up announcements → #💪︱levels');

        // Ensure level_role_rewards table exists
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS level_role_rewards (
                guild_id VARCHAR(20) NOT NULL,
                level INT NOT NULL,
                role_id VARCHAR(20) NOT NULL,
                PRIMARY KEY (guild_id, level)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Level rewards — matches existing Mee6 role tiers
        const rewards = [
            [5,  r.advancedSettler],
            [10, r.navigator],
            [15, r.dockMaster],
            [21, r.dockLord],
        ];
        for (const [level, roleId] of rewards) {
            await conn.execute(`
                INSERT INTO level_role_rewards (guild_id, level, role_id)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)
            `, [GUILD_ID, level, roleId]);
        }
        console.log('     ✓ Level rewards: 5→Advanced Settler, 10→Navigator, 15→Dock Master, 21→Dock Lord');

        // ================================================================
        // 3. AUTOMOD RULES
        // ================================================================
        console.log('\n3/6  automod_rules...');

        // Clear existing rules for this guild
        await conn.execute('DELETE FROM automod_rules WHERE guild_id = ?', [GUILD_ID]);

        const botChannel = JSON.stringify([ch.botCommands]);
        const staffJson = JSON.stringify(staffRoles);

        // Anti-Spam: 5 messages in 5 seconds = 5min mute
        await conn.execute(`
            INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
            VALUES (?, 'anti_spam', ?, 'mute', 5, 1, ?, ?)
        `, [
            GUILD_ID,
            JSON.stringify({ message_threshold: 5, time_window_seconds: 5, duplicate_threshold: 3 }),
            botChannel,
            staffJson,
        ]);

        // Discord Invite filter
        await conn.execute(`
            INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
            VALUES (?, 'discord_invites', ?, 'warn', NULL, 1, ?, ?)
        `, [
            GUILD_ID,
            JSON.stringify({ allow_own_server: true, allow_partnered: false, delete_message: true }),
            botChannel,
            staffJson,
        ]);

        // Mass Mentions: 5+ = 10min mute
        await conn.execute(`
            INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
            VALUES (?, 'mass_mentions', ?, 'mute', 10, 1, ?, ?)
        `, [
            GUILD_ID,
            JSON.stringify({ max_mentions: 5, max_role_mentions: 3, delete_message: true }),
            JSON.stringify([]),
            staffJson,
        ]);

        // All Caps: 70%+ over 10 chars = warn
        await conn.execute(`
            INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
            VALUES (?, 'all_caps', ?, 'warn', NULL, 1, ?, ?)
        `, [
            GUILD_ID,
            JSON.stringify({ min_length: 10, caps_percentage: 70, delete_message: false }),
            botChannel,
            staffJson,
        ]);

        // Banned Words: slur filter
        await conn.execute(`
            INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_channels, ignored_roles)
            VALUES (?, 'banned_words', ?, 'mute', 30, 1, ?, ?)
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

        console.log('     ✓ Anti-spam: 5 msgs/5sec → 5min mute');
        console.log('     ✓ Invite filter: External invites → warn');
        console.log('     ✓ Mass mentions: 5+ → 10min mute');
        console.log('     ✓ All caps: 70%+ → warn');
        console.log('     ✓ Banned words: Slur filter → 30min mute');

        // ================================================================
        // 4. PROTECTION SUITE
        // ================================================================
        console.log('\n4/6  protection suite...');

        // Adaptive Spam — cross-channel detection
        await conn.execute(`
            INSERT INTO adaptive_spam_config
                (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes,
                 deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h,
                 action, alert_channel_id)
            VALUES (?, 1, 3, 5, 2.00, 1.50, 2.00, 'mute', ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                alert_channel_id = VALUES(alert_channel_id)
        `, [GUILD_ID, ch.spamLogs]);
        console.log('     ✓ Adaptive spam → #spam-logs');

        // Raid Detection — 10 joins in 30 seconds
        await conn.execute(`
            INSERT INTO raid_detection_config
                (guild_id, enabled, join_threshold, join_timeframe_seconds,
                 new_account_age_hours, new_account_ratio, action,
                 alert_channel_id, mute_duration_minutes, purge_messages)
            VALUES (?, 1, 10, 30, 168, 0.70, 'alert', ?, 60, 0)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                alert_channel_id = VALUES(alert_channel_id)
        `, [GUILD_ID, ch.joinLogs]);
        console.log('     ✓ Raid detection: 10 joins/30s → alert #join-logs');

        // Anti-Nuke — mass action protection
        await conn.execute(`
            INSERT INTO anti_nuke_config
                (guild_id, enabled, max_channel_deletes, max_role_deletes,
                 max_kick_bans, action_on_trigger, alert_channel_id)
            VALUES (?, 1, 3, 3, 5, 'kick', ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                alert_channel_id = VALUES(alert_channel_id)
        `, [GUILD_ID, ch.allLogs]);
        console.log('     ✓ Anti-nuke: 3 deletes or 5 bans → kick');

        // Selfbot Detection
        await conn.execute(`
            INSERT INTO selfbot_detection_config
                (guild_id, enabled, min_response_time_ms, message_burst_threshold,
                 message_burst_window_ms, pattern_threshold, action,
                 alert_channel_id, exempt_roles)
            VALUES (?, 1, 50, 20, 1000, 3, 'alert', ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                alert_channel_id = VALUES(alert_channel_id),
                exempt_roles = VALUES(exempt_roles)
        `, [GUILD_ID, ch.allLogs, staffJson]);
        console.log('     ✓ Selfbot detection → #all-logs (staff exempt)');

        // ================================================================
        // 5. LOGGING
        // ================================================================
        console.log('\n5/6  logging_config...');
        await conn.execute(`
            INSERT INTO logging_config (guild_id, log_channel_id, enabled_events, enabled)
            VALUES (?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE
                log_channel_id = VALUES(log_channel_id),
                enabled_events = VALUES(enabled_events),
                enabled = 1
        `, [
            GUILD_ID,
            ch.allLogs,
            JSON.stringify([
                'messageDelete', 'messageUpdate', 'messageDeleteBulk',
                'memberJoin', 'memberLeave', 'memberUpdate',
                'roleCreate', 'roleUpdate', 'roleDelete',
                'channelCreate', 'channelUpdate', 'channelDelete',
                'guildBanAdd', 'guildBanRemove',
                'inviteCreate', 'inviteDelete',
            ]),
        ]);
        console.log('     ✓ Logging → #all-logs (all standard events)');

        // ================================================================
        // 6. ESCALATION RULES
        // ================================================================
        console.log('\n6/6  escalation_rules...');
        await conn.execute('DELETE FROM escalation_rules WHERE guild_id = ?', [GUILD_ID]);

        const escalations = [
            [3,  24,  'mute', 30],    // 3 infractions in 24h → 30min mute
            [5,  48,  'mute', 120],   // 5 in 48h → 2h mute
            [7,  168, 'kick', null],  // 7 in 1 week → kick
            [10, 720, 'ban',  null],  // 10 in 30 days → ban
        ];
        for (const [count, hours, action, duration] of escalations) {
            await conn.execute(`
                INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes)
                VALUES (?, ?, ?, ?, ?)
            `, [GUILD_ID, count, hours, action, duration]);
        }
        console.log('     ✓ Escalation: 3→30m mute, 5→2h mute, 7→kick, 10→ban');

    }); // end transaction

    // ================================================================
    // SUMMARY
    // ================================================================
    console.log('\n' + '='.repeat(50));
    console.log('SETUP COMPLETE — YYZ Studio');
    console.log('='.repeat(50));
    console.log('');
    console.log('Configured:');
    console.log('  [x] Guild record (announcements → #📢︱server-updates)');
    console.log('  [x] Welcome messages (#👋︱port) + auto-role (Settler)');
    console.log('  [x] Leveling (20 XP/msg, voice XP, announcements in #💪︱levels)');
    console.log('  [x] Level rewards: 5→Advanced Settler, 10→Navigator, 15→Dock Master, 21→Dock Lord');
    console.log('  [x] Automod (spam, invites, mass mentions, caps, slur filter)');
    console.log('  [x] Adaptive spam detection → #spam-logs');
    console.log('  [x] Raid detection (10 joins/30s) → #join-logs');
    console.log('  [x] Anti-nuke protection → #all-logs');
    console.log('  [x] Selfbot detection → #all-logs');
    console.log('  [x] Logging (all events) → #all-logs');
    console.log('  [x] Escalation rules (3→mute, 5→long mute, 7→kick, 10→ban)');
    console.log('');
    console.log('Restart the bot to apply:');
    console.log('  pm2 restart CertiFriedUtility');

    await pool.end();
    process.exit(0);
}

setup().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
});
