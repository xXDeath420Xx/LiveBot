/**
 * One-time setup script for CruciCafe Fam (877253051994501130)
 * Configures the full moderation/protection suite matching ReeferRealm/Insomniac standards.
 * Replaces Dyno, MEE6, and Streamcord.
 *
 * Usage: node scripts/setup-crucicafe.js
 */

import pool from '../utils/db.js';
import * as twitchApi from '../utils/platforms/twitch.js';

const GUILD_ID = '877253051994501130';
const GUILD_NAME = 'CruciCafe Fam';

// Channel IDs (from server audit)
const CHANNELS = {
    welcome:        '877253668133552240',  // 👋┊welcome
    announcements:  '877254930585518161',  // 📢┊announcements
    general:        '877253051994501132',  // 💬┊general
    streamDefault:  '1473629773598167190', // default live channel (all streamers)
    cruciIsLive:    '1249719945286385746', // cruci-is-live (crucicafe override)
    leveling:       '919349483874181190',  // 🏆┊leveling
    reactRoles:     '904428293846098011',  // 😎┊react-roles
    modLogs:        '929807906268926052',  // mod-logs (repurposed from Dyno)
    auditLogs:      '929807957653344337',  // message-logs → full audit log
    alertChannel:   '929807924891635722',  // channel-logs → protection alerts
};

// Role IDs
const ROLES = {
    member: '877254101065424976',
    muted:  '929799581410164786',
    live:   '905450509371068487',   // guild-wide LIVE role for ALL streamers
};

// Full event list matching ReeferRealm
const ENABLED_EVENTS = JSON.stringify([
    "memberJoin","memberLeave","memberKick","memberUpdate","memberTimeout",
    "ban","unban","automodAction","automodRuleCreate","automodRuleUpdate","automodRuleDelete",
    "voiceUpdate","voiceChannelEffect",
    "stageInstanceCreate","stageInstanceDelete","stageInstanceUpdate",
    "messageDelete","messageUpdate",
    "reactionAdd","reactionRemove","reactionRemoveAll","reactionRemoveEmoji",
    "pollVoteAdd","pollVoteRemove",
    "channelPinsUpdate","channelCreate","channelDelete","channelUpdate",
    "threadCreate","threadDelete","threadUpdate","threadMembersUpdate",
    "guildUpdate",
    "emojiCreate","emojiDelete","emojiUpdate",
    "stickerCreate","stickerDelete","stickerUpdate",
    "inviteCreate","inviteDelete",
    "webhookUpdate","integrationUpdate","integrationsUpdate",
    "soundboardSoundCreate","soundboardSoundDelete","soundboardSoundUpdate",
    "scheduledEventCreate","scheduledEventUpdate","scheduledEventDelete",
    "scheduledEventUserAdd","scheduledEventUserRemove",
    "roleCreate","roleDelete","roleUpdate",
    "commandUsage","giveaway","join-gate","moderation","poll","starboard",
    "sticky-roles","system","temp-channels","xp"
]);

async function setup() {
    console.log(`\n=== Setting up ${GUILD_NAME} (${GUILD_ID}) ===\n`);
    let connection;
    try {
        connection = await pool.getConnection();

        // 1. guilds table
        console.log('1/11  guilds...');
        await connection.execute(`
            INSERT INTO guilds (guild_id, guild_name, announcement_channel_id, live_role_id,
                                leveling_enabled, leveling_xp_rate, leveling_xp_cooldown,
                                sticky_roles_enabled, afk_enabled)
            VALUES (?, ?, ?, ?, 1, 20, 60, 1, 1)
            ON DUPLICATE KEY UPDATE
                guild_name = VALUES(guild_name),
                announcement_channel_id = VALUES(announcement_channel_id),
                live_role_id = VALUES(live_role_id),
                leveling_enabled = VALUES(leveling_enabled),
                leveling_xp_rate = VALUES(leveling_xp_rate),
                leveling_xp_cooldown = VALUES(leveling_xp_cooldown),
                sticky_roles_enabled = VALUES(sticky_roles_enabled),
                afk_enabled = VALUES(afk_enabled)
        `, [GUILD_ID, GUILD_NAME, CHANNELS.streamDefault, ROLES.live]);
        console.log('      ✓ guilds');

        // 2. guild_config table
        console.log('2/11  guild_config...');
        await connection.execute(`
            INSERT INTO guild_config (guild_id, prefix, language, timezone, bot_nickname, embed_color)
            VALUES (?, '!', 'en', 'UTC', 'Cafe Utility', '#8B4513')
            ON DUPLICATE KEY UPDATE
                bot_nickname = VALUES(bot_nickname),
                embed_color = VALUES(embed_color)
        `, [GUILD_ID]);
        console.log('      ✓ guild_config');

        // 3. moderation_config
        console.log('3/11  moderation_config...');
        await connection.execute(`
            INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
                mod_log_channel_id = VALUES(mod_log_channel_id),
                muted_role_id = VALUES(muted_role_id)
        `, [GUILD_ID, CHANNELS.modLogs, ROLES.muted]);
        console.log('      ✓ moderation_config');

        // 4. logging_config
        console.log('4/11  logging_config...');
        await connection.execute(`
            INSERT INTO logging_config (guild_id, log_channel_id, enabled, enabled_events)
            VALUES (?, ?, 1, ?)
            ON DUPLICATE KEY UPDATE
                log_channel_id = VALUES(log_channel_id),
                enabled = 1,
                enabled_events = VALUES(enabled_events)
        `, [GUILD_ID, CHANNELS.auditLogs, ENABLED_EVENTS]);
        console.log('      ✓ logging_config');

        // 5. escalation_rules — 3 infractions in 24h = ban (matching ReeferRealm/Insomniac)
        console.log('5/11  escalation_rules...');
        const [existingRules] = await connection.execute(
            'SELECT id FROM escalation_rules WHERE guild_id = ?', [GUILD_ID]
        );
        if (existingRules.length === 0) {
            await connection.execute(`
                INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action)
                VALUES (?, 3, 24, 'ban')
            `, [GUILD_ID]);
        }
        console.log('      ✓ escalation_rules');

        // 6. welcome_settings
        console.log('6/11  welcome_settings...');
        await connection.execute(`
            INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled)
            VALUES (?, ?, 'Welcome to CruciCafe Fam, {mention}! Grab a cup and make yourself at home.', 0)
            ON DUPLICATE KEY UPDATE
                channel_id = VALUES(channel_id),
                message = VALUES(message)
        `, [GUILD_ID, CHANNELS.welcome]);
        console.log('      ✓ welcome_settings');

        // 7. adaptive_spam_config
        console.log('7/11  adaptive_spam_config...');
        await connection.execute(`
            INSERT INTO adaptive_spam_config
                (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes,
                 deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h,
                 action, alert_channel_id)
            VALUES (?, 1, 3, 1, 2.00, 1.50, 2.00, 'mute', ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                alert_channel_id = VALUES(alert_channel_id)
        `, [GUILD_ID, CHANNELS.alertChannel]);
        console.log('      ✓ adaptive_spam_config');

        // 8. raid_detection_config
        console.log('8/11  raid_detection_config...');
        await connection.execute(`
            INSERT INTO raid_detection_config
                (guild_id, enabled, join_threshold, join_timeframe_seconds, new_account_age_hours,
                 new_account_ratio, action, mute_duration_minutes, purge_messages, alert_channel_id)
            VALUES (?, 1, 5, 60, 25, 0.30, 'kick', 10, 1, ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                alert_channel_id = VALUES(alert_channel_id)
        `, [GUILD_ID, CHANNELS.alertChannel]);
        console.log('      ✓ raid_detection_config');

        // 9. anti_nuke_config
        console.log('9/11  anti_nuke_config...');
        await connection.execute(`
            INSERT INTO anti_nuke_config
                (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger, alert_channel_id)
            VALUES (?, 1, 3, 3, 5, 'kick', ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                alert_channel_id = VALUES(alert_channel_id)
        `, [GUILD_ID, CHANNELS.alertChannel]);
        console.log('      ✓ anti_nuke_config');

        // 10. selfbot_detection_config
        console.log('10/11 selfbot_detection_config...');
        await connection.execute(`
            INSERT INTO selfbot_detection_config
                (guild_id, enabled, min_response_time_ms, message_burst_threshold, message_burst_window_ms,
                 pattern_threshold, action, exempt_roles, alert_channel_id)
            VALUES (?, 1, 50, 5, 100, 1, 'kick', '[]', ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                alert_channel_id = VALUES(alert_channel_id)
        `, [GUILD_ID, CHANNELS.alertChannel]);
        console.log('      ✓ selfbot_detection_config');

        // 11. Register crucicafe streamer + subscription
        console.log('11/11 crucicafe streamer + subscription...');
        const twitchUser = await twitchApi.getTwitchUser('crucicafe');
        if (!twitchUser) {
            console.log('      ⚠ Could not verify Twitch user "crucicafe" — skipping subscription');
            console.log('        Add manually later: /social streamer add twitch crucicafe');
        } else {
            console.log(`      Found Twitch user: ${twitchUser.login} (ID: ${twitchUser.id})`);

            // Upsert streamer
            const [existingStreamer] = await connection.execute(
                'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
                ['twitch', twitchUser.id]
            );

            let streamerId;
            if (existingStreamer.length > 0) {
                streamerId = existingStreamer[0].streamer_id;
                console.log(`      Streamer already registered (ID: ${streamerId})`);
            } else {
                const [result] = await connection.execute(
                    'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)',
                    ['twitch', twitchUser.id, twitchUser.login, '365905620060340224']
                );
                streamerId = result.insertId;
                console.log(`      Registered streamer (ID: ${streamerId})`);
            }

            // Upsert subscription — crucicafe posts to cruci-is-live, LIVE role from guild default
            const [existingSub] = await connection.execute(
                'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                [GUILD_ID, streamerId]
            );

            if (existingSub.length > 0) {
                console.log(`      Subscription already exists (ID: ${existingSub[0].subscription_id})`);
            } else {
                await connection.execute(`
                    INSERT INTO subscriptions
                        (guild_id, streamer_id, announcement_channel_id, custom_message, delete_on_end)
                    VALUES (?, ?, ?, '{streamer} is now live! Come hang out!', 1)
                `, [GUILD_ID, streamerId, CHANNELS.cruciIsLive]);
                console.log('      ✓ subscription created (cruci-is-live channel)');
            }
        }

        console.log(`\n=== Setup complete for ${GUILD_NAME} ===`);
        console.log('\nNext steps:');
        console.log('  1. node scripts/deploy-commands-to-bot.js 1473622894138491007');
        console.log('  2. pm2 restart CertiFriedUtility');
        console.log('  3. Cross-pollinate will happen after restart via guild enable event');

    } catch (error) {
        console.error('Setup failed:', error);
        process.exit(1);
    } finally {
        if (connection) connection.release();
        await pool.end();
        process.exit(0);
    }
}

setup();
