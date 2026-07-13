/**
 * Setup for guild 1428091358522114090 (Wolves of shadows) with custom bot 1506374126594691092 (DarkWolf).
 *
 * Lean baseline modelled on scripts/setup-guild-1500965606659194982.js. Idempotent.
 *
 * Pre-existing surface this script discovers and preserves rather than recreating:
 *   - welcome channel    1428141508804087829   (welcome_settings.channel_id)
 *   - goodbye channel    1448852474701287435   (welcome_settings.goodbye_channel_id)
 *   - stream-announce    1428140205151621191   (12 active subscriptions point here)
 *
 * Deliberately NOT touched (handled later via dashboard / commands):
 *   - self_promo_config            (URL-parser pipeline — never default-enabled)
 *   - guild_streamer_auto_track    (no role-based opt-in yet)
 *   - subscriptions table          (12 rows already present, untouched)
 *
 * Run sequence (PM2 must be stopped — feedback_competing_sessions.md):
 *   pm2 stop CertiFriedUtility
 *   node scripts/setup-guild-1428091358522114090.js
 *   node scripts/deploy-commands-to-bot.js 1506374126594691092
 *   pm2 restart CertiFriedUtility
 */
import dotenv from 'dotenv';
dotenv.config();
import {
    Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1428091358522114090';
const BOT_ID = '1506374126594691092';

const PRESERVED = {
    welcomeChannelId: '1428141508804087829',
    goodbyeChannelId: '1448852474701287435',
    streamAnnounceChannelId: '1428140205151621191',
};

const ROLE_DEFS = {
    moderator:    { name: '🛠️ Moderator',     color: 0x3498DB, hoist: true,  permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.MoveMembers] },
    liveStreamer: { name: '🔴 Live Streamer',  color: 0xE91E63, hoist: true },
    verified:     { name: '✅ Verified',       color: 0x2ECC71 },
    announce:     { name: '📢 Announcements', color: 0x95A5A6, mentionable: true },
    streamPings:  { name: '🔔 Stream Pings',  color: 0x95A5A6, mentionable: true },
    giveaways:    { name: '🎉 Giveaways',      color: 0x95A5A6, mentionable: true },
    lvl5:         { name: '🌱 Pup (Lv 5)',     color: 0x95E1D3 },
    lvl10:        { name: '🐺 Yearling (Lv 10)', color: 0xF7B731 },
    lvl25:        { name: '🐺 Hunter (Lv 25)',  color: 0xE15F41 },
    lvl50:        { name: '🐺 Alpha (Lv 50)',   color: 0xA55EEA },
    lvl100:        { name: '🐺 Legend (Lv 100)', color: 0xEB4D4B },
    muted:        { name: '🔇 Muted',          color: 0x607D8B },
};

const LEVEL_REWARDS = [
    [5,   'lvl5'],
    [10,  'lvl10'],
    [25,  'lvl25'],
    [50,  'lvl50'],
    [100, 'lvl100'],
];

async function main() {
    const [bots] = await pool.execute('SELECT bot_token, bot_name FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.error(`Bot ${BOT_ID} not found in custom_bots`); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));
    console.log(`Using custom bot: ${bots[0].bot_name} (${BOT_ID})`);

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates,
        ],
    });

    await client.login(token);
    await new Promise(resolve => client.once('ready', resolve));
    console.log(`Logged in as ${client.user.tag}\n`);

    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) { console.error(`Guild ${GUILD_ID} not accessible`); client.destroy(); process.exit(1); }
    console.log(`Connected to: ${guild.name} (${guild.memberCount} members)\n`);

    await guild.channels.fetch();
    await guild.roles.fetch();

    const log = (msg) => console.log(`[Setup] ${msg}`);
    const configured = [];

    // ═══ 1. Roles ═══
    log('Step 1: Roles');
    async function findOrCreateRole(key) {
        const def = ROLE_DEFS[key];
        let r = guild.roles.cache.find(x => x.name === def.name);
        if (r) { log(`  ✓ Role "${def.name}" exists (${r.id})`); return r; }
        r = await guild.roles.create({
            name: def.name, color: def.color, hoist: def.hoist || false,
            mentionable: def.mentionable || false, permissions: def.permissions || [],
            reason: 'Baseline setup (DarkWolf)',
        });
        log(`  + Created role "${def.name}" (${r.id})`);
        return r;
    }
    const roles = {};
    for (const key of Object.keys(ROLE_DEFS)) roles[key] = await findOrCreateRole(key);
    configured.push(`${Object.keys(ROLE_DEFS).length} roles`);

    // ═══ 2. Categories & channels ═══
    log('\nStep 2: Categories & channels');

    const everyoneId = guild.id;
    const botId = client.user.id;

    const PUBLIC_VIEW_OW = [
        { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ];
    const VERIFIED_ONLY_OW = [
        { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
        { id: roles.verified.id, allow: [PermissionFlagsBits.ViewChannel] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ];
    const STAFF_ONLY_OW = [
        { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
        { id: roles.moderator.id, allow: [PermissionFlagsBits.ViewChannel] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
    ];

    async function findOrCreateCategory(name, overwrites) {
        let c = guild.channels.cache.find(x => x.type === ChannelType.GuildCategory && x.name === name);
        if (c) { log(`  ✓ Category "${name}" exists`); return c; }
        c = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
        log(`  + Created category "${name}"`);
        return c;
    }
    async function findOrCreateChannel(name, type, parent, overwrites = null, extra = {}) {
        let c = guild.channels.cache.find(x => x.type === type && x.name === name && x.parentId === parent.id);
        if (c) { log(`  ✓ Channel "${name}" exists`); return c; }
        const opts = { name, type, parent: parent.id, ...extra };
        if (overwrites) opts.permissionOverwrites = overwrites;
        c = await guild.channels.create(opts);
        log(`  + Created channel "${name}"`);
        return c;
    }

    const catInfo      = await findOrCreateCategory('📋 Information', PUBLIC_VIEW_OW);
    const catCommunity = await findOrCreateCategory('💬 Community',   VERIFIED_ONLY_OW);
    const catVoice     = await findOrCreateCategory('🔊 Voice',       VERIFIED_ONLY_OW);
    const catStaff     = await findOrCreateCategory('🔧 Staff',       STAFF_ONLY_OW);
    const catLogs      = await findOrCreateCategory('📜 Logs',        STAFF_ONLY_OW);
    const catStats     = await findOrCreateCategory('📊 Stats', [
        { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] },
    ]);

    // Information
    const chRules    = await findOrCreateChannel('rules', ChannelType.GuildText, catInfo, [
        { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: botId, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ]);
    const chRoles    = await findOrCreateChannel('roles', ChannelType.GuildText, catInfo, [
        { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: botId, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ]);

    // Preserved channels — fetch by known ID rather than creating duplicates
    const chWelcome        = guild.channels.cache.get(PRESERVED.welcomeChannelId)        || chRules;
    const chGoodbye        = guild.channels.cache.get(PRESERVED.goodbyeChannelId)        || chRules;
    const chStreamAnnounce = guild.channels.cache.get(PRESERVED.streamAnnounceChannelId) || null;
    if (chWelcome.id !== PRESERVED.welcomeChannelId) log(`  ! welcome channel ${PRESERVED.welcomeChannelId} not found — fell back to #rules`);
    if (chGoodbye.id !== PRESERVED.goodbyeChannelId) log(`  ! goodbye channel ${PRESERVED.goodbyeChannelId} not found — fell back to #rules`);
    if (!chStreamAnnounce) log(`  ! stream-announce channel ${PRESERVED.streamAnnounceChannelId} not found — subscriptions may be orphaned`);

    // Community
    const chGeneral  = await findOrCreateChannel('general', ChannelType.GuildText, catCommunity);
    const chMedia    = await findOrCreateChannel('media',   ChannelType.GuildText, catCommunity);
    const chSupport  = await findOrCreateChannel('support', ChannelType.GuildText, catCommunity);

    // Voice
    const chGeneralVC = await findOrCreateChannel('🔊 General VC', ChannelType.GuildVoice, catVoice);
    const chCreateVC  = await findOrCreateChannel('➕ Create VC',  ChannelType.GuildVoice, catVoice);

    // Staff
    const chModChat       = await findOrCreateChannel('mod-chat',      ChannelType.GuildText, catStaff);
    const chModLogs       = await findOrCreateChannel('mod-logs',      ChannelType.GuildText, catStaff);
    const chTicketAlerts  = await findOrCreateChannel('ticket-alerts', ChannelType.GuildText, catStaff);
    const chTicketLogs    = await findOrCreateChannel('ticket-logs',   ChannelType.GuildText, catStaff);
    const ticketCategory  = await findOrCreateCategory('🎫 Tickets', STAFF_ONLY_OW);

    // Logs
    const chMemberLog  = await findOrCreateChannel('member-log',  ChannelType.GuildText, catLogs);
    const chMessageLog = await findOrCreateChannel('message-log', ChannelType.GuildText, catLogs);
    const chVoiceLog   = await findOrCreateChannel('voice-log',   ChannelType.GuildText, catLogs);
    const chChannelLog = await findOrCreateChannel('channel-log', ChannelType.GuildText, catLogs);
    const chRoleLog    = await findOrCreateChannel('role-log',    ChannelType.GuildText, catLogs);
    const chServerLog  = await findOrCreateChannel('server-log',  ChannelType.GuildText, catLogs);
    const chAutomodLog = await findOrCreateChannel('automod-log', ChannelType.GuildText, catLogs);

    // Stat display (3 VCs — names rewritten by stat-display scheduler)
    const chStatMembers = await findOrCreateChannel('👥 Members: …', ChannelType.GuildVoice, catStats);
    const chStatHumans  = await findOrCreateChannel('🧑 Humans: …',  ChannelType.GuildVoice, catStats);
    const chStatBots    = await findOrCreateChannel('🤖 Bots: …',    ChannelType.GuildVoice, catStats);

    configured.push('6 categories, ~20 channels');

    // ═══ 3. Muted role denies ═══
    log('\nStep 3: Muted role denies');
    let mutedApplied = 0;
    for (const [, ch] of guild.channels.cache) {
        if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum].includes(ch.type)) continue;
        try {
            await ch.permissionOverwrites.edit(roles.muted.id, {
                SendMessages: false, AddReactions: false, Speak: false, SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false,
            }, { reason: 'Baseline mute role overwrites' });
            mutedApplied++;
        } catch {}
    }
    log(`  Applied mute denies to ${mutedApplied} channels`);
    configured.push(`Muted role: ${mutedApplied} channels`);

    // ═══ 4. DB configs ═══
    log('\nStep 4: DB configs');

    await pool.execute(
        'INSERT INTO guild_config (guild_id, prefix, language) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE guild_id = guild_id',
        [GUILD_ID, '!', 'en']
    ).catch(() => {});

    // guilds — preserve stream-announce channel if present
    await pool.execute(
        `INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id, use_webhook_persona)
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE announcement_channel_id = COALESCE(VALUES(announcement_channel_id), announcement_channel_id),
                                 live_role_id = VALUES(live_role_id)`,
        [GUILD_ID, chStreamAnnounce?.id || null, roles.liveStreamer.id]
    ).catch(e => log(`  ! guilds insert failed: ${e.message}`));

    // verify_config (rules-button gate)
    await pool.execute(
        `INSERT INTO verify_config (guild_id, verified_role_id, unverified_role_id, gate_channel_id, enabled, unverified_kick_days)
         VALUES (?, ?, NULL, ?, 1, 0)
         ON DUPLICATE KEY UPDATE verified_role_id = VALUES(verified_role_id), gate_channel_id = VALUES(gate_channel_id), enabled = 1`,
        [GUILD_ID, roles.verified.id, chRules.id]
    ).catch(e => log(`  ! verify_config failed: ${e.message}`));
    log('  ✓ verify_config');

    // welcome_settings — preserve existing channel_id and goodbye_channel_id
    await pool.execute(
        `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, goodbye_enabled, goodbye_channel_id)
         VALUES (?, ?, ?, 1, 1, ?)
         ON DUPLICATE KEY UPDATE
             channel_id          = COALESCE(channel_id, VALUES(channel_id)),
             banner_enabled      = banner_enabled,
             goodbye_enabled     = goodbye_enabled,
             goodbye_channel_id  = COALESCE(goodbye_channel_id, VALUES(goodbye_channel_id))`,
        [GUILD_ID, chWelcome.id, `{mention} — welcome to **${guild.name}**! Read <#${chRules.id}> and click ✅ I Agree to unlock the rest of the server.`, chGoodbye.id]
    ).catch(e => log(`  ! welcome_settings failed: ${e.message}`));
    log('  ✓ welcome_settings (preserved existing channel_ids)');

    // logging_config + log_event_config
    const enabledEvents = [
        'memberJoin','memberLeave','memberUpdate','messageDelete','messageUpdate','channelPinsUpdate',
        'ban','unban','memberKick','memberTimeout','automodAction','inviteCreate','inviteDelete',
        'voiceUpdate','channelCreate','channelDelete','channelUpdate','threadCreate','threadDelete','threadUpdate',
        'roleCreate','roleDelete','roleUpdate','scheduledEventCreate','scheduledEventDelete','scheduledEventUpdate',
    ];
    await pool.execute(
        `INSERT INTO logging_config (guild_id, log_channel_id, enabled, enabled_events)
         VALUES (?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), enabled = 1, enabled_events = VALUES(enabled_events)`,
        [GUILD_ID, chMemberLog.id, JSON.stringify(enabledEvents)]
    ).catch(e => log(`  ! logging_config failed: ${e.message}`));
    await pool.execute('DELETE FROM log_event_config WHERE guild_id = ?', [GUILD_ID]).catch(() => {});
    const routes = [
        ['memberJoin', chMemberLog.id, '#43B581'], ['memberLeave', chMemberLog.id, '#E67E22'], ['memberUpdate', chMemberLog.id, '#3498DB'],
        ['messageDelete', chMessageLog.id, '#E74C3C'], ['messageUpdate', chMessageLog.id, '#F1C40F'], ['channelPinsUpdate', chMessageLog.id, '#3498DB'],
        ['ban', chModLogs.id, '#8B0000'], ['unban', chModLogs.id, '#43B581'], ['memberKick', chModLogs.id, '#E74C3C'], ['memberTimeout', chModLogs.id, '#E67E22'],
        ['automodAction', chAutomodLog.id, '#9B59B6'], ['inviteCreate', chServerLog.id, '#3498DB'], ['inviteDelete', chServerLog.id, '#E67E22'],
        ['voiceUpdate', chVoiceLog.id, '#9B59B6'],
        ['channelCreate', chChannelLog.id, '#43B581'], ['channelDelete', chChannelLog.id, '#E74C3C'], ['channelUpdate', chChannelLog.id, '#3498DB'],
        ['threadCreate', chChannelLog.id, '#43B581'], ['threadDelete', chChannelLog.id, '#E74C3C'], ['threadUpdate', chChannelLog.id, '#3498DB'],
        ['roleCreate', chRoleLog.id, '#43B581'], ['roleDelete', chRoleLog.id, '#E74C3C'], ['roleUpdate', chRoleLog.id, '#3498DB'],
        ['scheduledEventCreate', chServerLog.id, '#43B581'], ['scheduledEventDelete', chServerLog.id, '#E74C3C'], ['scheduledEventUpdate', chServerLog.id, '#3498DB'],
    ];
    for (const [evt, ch, color] of routes) {
        await pool.execute('INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id, embed_color) VALUES (?, ?, 1, ?, ?)', [GUILD_ID, evt, ch, color]).catch(() => {});
    }
    log(`  ✓ logging_config + ${routes.length} event routes`);

    // moderation_config
    await pool.execute(
        `INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE mod_log_channel_id = VALUES(mod_log_channel_id), muted_role_id = VALUES(muted_role_id)`,
        [GUILD_ID, chModLogs.id, roles.muted.id]
    ).catch(e => log(`  ! moderation_config failed: ${e.message}`));
    log('  ✓ moderation_config');

    // Protection stack
    await pool.execute(
        `INSERT INTO anti_nuke_config (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger, alert_channel_id)
         VALUES (?, 1, 3, 3, 5, 'strip_roles', ?)
         ON DUPLICATE KEY UPDATE enabled = 1, alert_channel_id = VALUES(alert_channel_id)`,
        [GUILD_ID, chModLogs.id]
    ).catch(e => log(`  ! anti_nuke_config failed: ${e.message}`));
    await pool.execute(
        `INSERT INTO raid_detection_config (guild_id, enabled, join_threshold, join_timeframe_seconds, new_account_age_hours, new_account_ratio, action, alert_channel_id, mute_duration_minutes, purge_messages)
         VALUES (?, 1, 10, 30, 24, 0.50, 'mute', ?, 60, 1)
         ON DUPLICATE KEY UPDATE enabled = 1, alert_channel_id = VALUES(alert_channel_id)`,
        [GUILD_ID, chModLogs.id]
    ).catch(e => log(`  ! raid_detection_config failed: ${e.message}`));
    await pool.execute(
        `INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes, deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action, alert_channel_id)
         VALUES (?, 1, 5, 2, 3.00, 1.50, 2.00, 'delete+warn', ?)
         ON DUPLICATE KEY UPDATE enabled = 1, alert_channel_id = VALUES(alert_channel_id)`,
        [GUILD_ID, chModLogs.id]
    ).catch(e => log(`  ! adaptive_spam_config failed: ${e.message}`));
    try {
        await pool.execute(
            `INSERT INTO selfbot_detection_config (guild_id, enabled, min_response_time_ms, message_burst_threshold, message_burst_window_ms, pattern_threshold, action, alert_channel_id, mute_duration_minutes, purge_messages)
             VALUES (?, 1, 300, 6, 2000, 4, 'mute', ?, 30, 1)
             ON DUPLICATE KEY UPDATE enabled = 1, alert_channel_id = VALUES(alert_channel_id)`,
            [GUILD_ID, chModLogs.id]
        );
    } catch (e) {
        if (/Unknown column/i.test(e.message)) {
            await pool.execute(
                `INSERT INTO selfbot_detection_config (guild_id, enabled, min_response_time_ms, message_burst_threshold, message_burst_window_ms, pattern_threshold, action, alert_channel_id)
                 VALUES (?, 1, 300, 6, 2000, 4, 'mute', ?)
                 ON DUPLICATE KEY UPDATE enabled = 1, alert_channel_id = VALUES(alert_channel_id)`,
                [GUILD_ID, chModLogs.id]
            );
        } else { log(`  ! selfbot_detection_config failed: ${e.message}`); }
    }
    await pool.execute(
        `INSERT INTO phishing_config (guild_id, enabled, action, mute_duration_minutes, alert_channel_id, log_detections, report_channel_id)
         VALUES (?, 1, 'delete', 60, ?, 1, ?)
         ON DUPLICATE KEY UPDATE enabled = 1, alert_channel_id = VALUES(alert_channel_id), report_channel_id = VALUES(report_channel_id)`,
        [GUILD_ID, chModLogs.id, chAutomodLog.id]
    ).catch(e => log(`  ! phishing_config failed: ${e.message}`));
    log('  ✓ protection stack (anti-nuke, raid, spam, selfbot, phishing)');

    // Temp VC creator
    await pool.execute(
        `INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template, required_role_id, default_user_limit)
         VALUES (?, ?, ?, ?, NULL, NULL)
         ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), naming_template = VALUES(naming_template)`,
        [GUILD_ID, chCreateVC.id, catVoice.id, "{user}'s VC"]
    ).catch(e => log(`  ! temp VC failed: ${e.message}`));
    log('  ✓ temp_channel_config');

    // Leveling
    await pool.execute(
        `INSERT INTO level_config (guild_id, enabled, xp_per_message, xp_cooldown_seconds, level_up_channel_id)
         VALUES (?, 1, 15, 60, ?)
         ON DUPLICATE KEY UPDATE enabled = 1, xp_per_message = VALUES(xp_per_message), xp_cooldown_seconds = VALUES(xp_cooldown_seconds), level_up_channel_id = VALUES(level_up_channel_id)`,
        [GUILD_ID, chGeneral.id]
    ).catch(e => log(`  ! level_config failed: ${e.message}`));
    for (const [lvl, key] of LEVEL_REWARDS) {
        await pool.execute(
            `INSERT INTO level_rewards (guild_id, level, role_id) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)`,
            [GUILD_ID, lvl, roles[key].id]
        ).catch(e => log(`  ! level_rewards lvl ${lvl} failed: ${e.message}`));
    }
    log(`  ✓ level_config + ${LEVEL_REWARDS.length} rewards`);

    // Stat display channels — wipe and reseed (idempotent without composite key)
    await pool.execute('DELETE FROM stat_display_channels WHERE guild_id = ?', [GUILD_ID]).catch(() => {});
    const statRows = [
        [chStatMembers.id, 'members', '👥 Members: {value}'],
        [chStatHumans.id,  'humans',  '🧑 Humans: {value}'],
        [chStatBots.id,    'bots',    '🤖 Bots: {value}'],
    ];
    for (const [chId, type, tmpl] of statRows) {
        await pool.execute(
            'INSERT INTO stat_display_channels (guild_id, channel_id, stat_type, template) VALUES (?, ?, ?, ?)',
            [GUILD_ID, chId, type, tmpl]
        ).catch(e => log(`  ! stat_display ${type} failed: ${e.message}`));
    }
    log(`  ✓ stat_display_channels × ${statRows.length}`);

    // Ticket panel — idempotent on (guild_id, panel_name)
    const [existingPanels] = await pool.execute(
        `SELECT panel_id FROM ticket_panels WHERE guild_id = ? AND panel_name = ?`,
        [GUILD_ID, 'general-support']
    );
    if (existingPanels.length) {
        await pool.execute(
            `UPDATE ticket_panels SET panel_channel_id = ?, ticket_category_id = ?, support_role_id = ?, log_channel_id = ?, alert_channel_id = ?, is_active = 1
             WHERE panel_id = ?`,
            [chSupport.id, ticketCategory.id, roles.moderator.id, chTicketLogs.id, chTicketAlerts.id, existingPanels[0].panel_id]
        );
        log(`  ✓ ticket_panels (updated panel ${existingPanels[0].panel_id})`);
    } else {
        await pool.execute(
            `INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color, button_text, ticket_category_id, support_role_id, ticket_name_format, save_transcripts, log_channel_id, alert_channel_id, is_active)
             VALUES (?, 'general-support', ?, ?, ?, '#5865F2', 'Open Ticket', ?, ?, 'ticket-{username}', 1, ?, ?, 1)`,
            [GUILD_ID, chSupport.id, 'Need help?', `Open a ticket and a member of staff will respond.`, ticketCategory.id, roles.moderator.id, chTicketLogs.id, chTicketAlerts.id]
        );
        log('  ✓ ticket_panels (created)');
    }

    // ═══ 5. Embeds & panels ═══
    log('\nStep 5: Embeds & panels');

    // 5a. Rules + verify
    try {
        const oldMessages = await chRules.messages.fetch({ limit: 50 }).catch(() => null);
        if (oldMessages?.size) await chRules.bulkDelete(oldMessages, true).catch(() => {});

        const rulesEmbed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle(`📜 ${guild.name} — Rules`)
            .setDescription('Read these, click **✅ I Agree** below, and you\'re in.')
            .addFields(
                { name: '1. Follow Discord ToS', value: 'https://discord.com/terms — applies to everything you do here.' },
                { name: '2. Be respectful', value: 'No harassment, hate speech, doxxing, slurs, or aggressive trolling.' },
                { name: '3. No spam / NSFW outside marked channels', value: 'Mass pings, raids, NSFW dumps, malicious links — instant ban.' },
                { name: '4. Staff has final say', value: 'Mods can take action even when something isn\'t explicitly listed.' },
            )
            .setFooter({ text: 'Click below to accept and unlock the rest of the server.' });

        const verifyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`rr_${roles.verified.id}`).setLabel('✅ I Agree').setStyle(ButtonStyle.Success)
        );
        const rulesMsg = await chRules.send({ embeds: [rulesEmbed], components: [verifyRow] });

        await pool.execute(
            `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
             VALUES (?, ?, ?, 'rules-verify', 'Server rules + verify', '#2ECC71', 'button', 'standard')
             ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), channel_id = VALUES(channel_id)`,
            [GUILD_ID, chRules.id, rulesMsg.id]
        );
        const [[panel]] = await pool.execute(
            `SELECT id FROM reaction_role_panels WHERE guild_id = ? AND panel_name = 'rules-verify' ORDER BY id DESC LIMIT 1`,
            [GUILD_ID]
        );
        if (panel) {
            await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);
            await pool.execute(
                `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style)
                 VALUES (?, ?, '✅', 'I Agree', 'success')`,
                [panel.id, roles.verified.id]
            );
            await pool.execute(`UPDATE verify_config SET gate_message_id = ? WHERE guild_id = ?`, [rulesMsg.id, GUILD_ID]).catch(() => {});
        }
        log(`  ✓ Rules + verify posted (${rulesMsg.id})`);
        configured.push('Rules + verify panel');
    } catch (e) {
        log(`  ! Rules panel failed: ${e.message}`);
    }

    // 5b. Notifications panel
    const styleName = (s) => ({
        [ButtonStyle.Primary]:   'primary',
        [ButtonStyle.Secondary]: 'secondary',
        [ButtonStyle.Success]:   'success',
        [ButtonStyle.Danger]:    'danger',
    }[s] || 'primary');

    try {
        const oldMessages = await chRoles.messages.fetch({ limit: 50 });
        if (oldMessages.size) await chRoles.bulkDelete(oldMessages, true).catch(() => {});

        const notifEmbed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('🔔 Notification Roles')
            .setDescription('Click a button to toggle. Get pinged when stuff happens.')
            .addFields(
                { name: '📢 Announcements', value: 'Server announcements & updates', inline: true },
                { name: '🎉 Giveaways',     value: 'Get pinged for giveaways',       inline: true },
                { name: '🔔 Stream Pings',  value: 'Get pinged when streamers go live', inline: true },
            );

        const mappings = [
            { roleId: roles.announce.id,    label: 'Announcements', emoji: '📢', style: ButtonStyle.Primary },
            { roleId: roles.giveaways.id,   label: 'Giveaways',     emoji: '🎉', style: ButtonStyle.Primary },
            { roleId: roles.streamPings.id, label: 'Stream Pings',  emoji: '🔔', style: ButtonStyle.Primary },
        ];
        const row = new ActionRowBuilder().addComponents(
            ...mappings.map(m => new ButtonBuilder().setCustomId(`rr_${m.roleId}`).setLabel(m.label).setStyle(m.style).setEmoji(m.emoji))
        );
        const notifMsg = await chRoles.send({ embeds: [notifEmbed], components: [row] });

        await pool.execute(
            `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
             VALUES (?, ?, ?, 'notifications', 'Notification roles', '#3498DB', 'button', 'standard')
             ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), channel_id = VALUES(channel_id)`,
            [GUILD_ID, chRoles.id, notifMsg.id]
        );
        const [[p]] = await pool.execute(
            `SELECT id FROM reaction_role_panels WHERE guild_id = ? AND panel_name = 'notifications' ORDER BY id DESC LIMIT 1`,
            [GUILD_ID]
        );
        if (p) {
            await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [p.id]);
            for (const m of mappings) {
                await pool.execute(
                    `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?, ?, ?, ?, ?)`,
                    [p.id, m.roleId, m.emoji, m.label, styleName(m.style)]
                );
            }
        }
        log(`  ✓ Notifications panel posted (${notifMsg.id})`);
        configured.push('Notifications panel');
    } catch (e) { log(`  ! Notifications panel failed: ${e.message}`); }

    // ═══ 6. Verification ═══
    log('\nStep 6: Verification');
    const verify = async (sql, params, label) => {
        const [r] = await pool.execute(sql, params);
        const n = Array.isArray(r) ? r[0]?.n ?? 0 : 0;
        log(`  ${n > 0 ? '✓' : '!'} ${label}: ${n}`);
        return n;
    };
    await verify('SELECT COUNT(*) AS n FROM guild_bot_mapping WHERE guild_id = ? AND bot_id = ?', [GUILD_ID, BOT_ID], 'guild_bot_mapping');
    await verify('SELECT COUNT(*) AS n FROM verify_config WHERE guild_id = ?',           [GUILD_ID], 'verify_config');
    await verify('SELECT COUNT(*) AS n FROM logging_config WHERE guild_id = ?',          [GUILD_ID], 'logging_config');
    await verify('SELECT COUNT(*) AS n FROM log_event_config WHERE guild_id = ?',        [GUILD_ID], 'log_event_config');
    await verify('SELECT COUNT(*) AS n FROM reaction_role_panels WHERE guild_id = ?',    [GUILD_ID], 'reaction_role_panels');
    await verify('SELECT COUNT(*) AS n FROM temp_channel_config WHERE guild_id = ?',     [GUILD_ID], 'temp_channel_config');
    await verify('SELECT COUNT(*) AS n FROM anti_nuke_config WHERE guild_id = ? AND enabled = 1',      [GUILD_ID], 'anti_nuke_config enabled');
    await verify('SELECT COUNT(*) AS n FROM raid_detection_config WHERE guild_id = ? AND enabled = 1', [GUILD_ID], 'raid_detection_config enabled');
    await verify('SELECT COUNT(*) AS n FROM phishing_config WHERE guild_id = ? AND enabled = 1',       [GUILD_ID], 'phishing_config enabled');
    await verify('SELECT COUNT(*) AS n FROM adaptive_spam_config WHERE guild_id = ? AND enabled = 1',  [GUILD_ID], 'adaptive_spam_config enabled');
    await verify('SELECT COUNT(*) AS n FROM level_config WHERE guild_id = ? AND enabled = 1',          [GUILD_ID], 'level_config enabled');
    await verify('SELECT COUNT(*) AS n FROM level_rewards WHERE guild_id = ?',           [GUILD_ID], 'level_rewards');
    await verify('SELECT COUNT(*) AS n FROM stat_display_channels WHERE guild_id = ?',   [GUILD_ID], 'stat_display_channels');
    await verify('SELECT COUNT(*) AS n FROM ticket_panels WHERE guild_id = ? AND is_active = 1', [GUILD_ID], 'ticket_panels active');
    await verify('SELECT COUNT(*) AS n FROM subscriptions WHERE guild_id = ?',           [GUILD_ID], 'subscriptions (preserved)');

    // ═══ Summary ═══
    console.log('\n' + '═'.repeat(60));
    console.log(`SETUP COMPLETE — ${guild.name}`);
    console.log('═'.repeat(60));
    configured.forEach(c => console.log(`  [OK] ${c}`));
    console.log('\nManual TODOs:');
    console.log(`  1. node scripts/deploy-commands-to-bot.js ${BOT_ID}`);
    console.log('  2. pm2 restart CertiFriedUtility');
    console.log(`  3. Drag DarkWolf's role above ALL assignable roles (Verified, Live Streamer, level tiers, notification roles)`);
    console.log('  4. node scripts/darkwolf-default-bot-leave.mjs   (remove default bot from guild — only after DarkWolf verified)');
    console.log('═'.repeat(60));

    client.destroy();
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
