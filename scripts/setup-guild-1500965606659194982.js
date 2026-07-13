/**
 * Setup script for guild 1500965606659194982 with bot 1502798840124670133.
 *
 * Builds a "lean baseline" community server modelled on (but lighter than)
 * guild 1475096615940521994. Idempotent — every DB write uses ON DUPLICATE
 * KEY UPDATE, every channel/role/category uses findOrCreate. Safe to re-run,
 * but a re-run will reset channel-mapped configs to whatever this script
 * discovers/creates (dashboard customizations to those mappings will be lost).
 *
 * Stop PM2 before running:  pm2 stop CertiFriedUtility
 * Run:                       node scripts/setup-guild-1500965606659194982.js
 * After:                     node scripts/deploy-commands-to-bot.js 1502798840124670133
 *                            pm2 restart CertiFriedUtility
 */
import dotenv from 'dotenv';
dotenv.config();
import {
    Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID = '1502798840124670133';

// Pre-existing roles in this guild — referenced by ID so re-runs don't create duplicates.
const PRE_EXISTING_ROLES = {
    owner: '1502751525728948366', // "House Master"
    admin: '1502737822245978253', // "House Keeper's"
};

const ROLE_DEFS = {
    // owner & admin are looked up by PRE_EXISTING_ROLES.* — not (re-)created.
    owner:        { existingId: PRE_EXISTING_ROLES.owner },
    admin:        { existingId: PRE_EXISTING_ROLES.admin },
    moderator:    { name: '🛠️ Moderator',      color: 0x3498DB, hoist: true,  permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.MoveMembers] },
    liveStreamer: { name: '🔴 Live Streamer',   color: 0xE91E63, hoist: true },
    verified:     { name: '✅ Verified',        color: 0x2ECC71 },
    arcRaiders:   { name: '🎮 Arc Raiders',    color: 0x8E44AD, hoist: false, mentionable: true },
    announce:     { name: '📢 Announcements',  color: 0x95A5A6, mentionable: true },
    giveaways:    { name: '🎉 Giveaways',       color: 0x95A5A6, mentionable: true },
    streamPings:  { name: '🔔 Stream Pings',   color: 0x95A5A6, mentionable: true },
    muted:        { name: '🔇 Muted',           color: 0x607D8B },
};

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
    await guild.members.fetch();

    const log = (msg) => console.log(`[Setup] ${msg}`);
    const configured = [];

    // ═══ 1. Roles ═══
    log('Step 1: Roles');
    async function findOrCreateRole(key) {
        const def = ROLE_DEFS[key];
        if (def.existingId) {
            const r = guild.roles.cache.get(def.existingId);
            if (!r) throw new Error(`Pre-existing role for "${key}" (${def.existingId}) not found in guild`);
            log(`  ✓ Using pre-existing role "${r.name}" (${r.id}) for "${key}"`);
            return r;
        }
        let r = guild.roles.cache.find(x => x.name === def.name);
        if (r) { log(`  ✓ Role "${def.name}" exists (${r.id})`); return r; }
        r = await guild.roles.create({
            name: def.name, color: def.color, hoist: def.hoist || false,
            mentionable: def.mentionable || false, permissions: def.permissions || [],
            reason: 'Baseline setup',
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
        { id: roles.admin.id, allow: [PermissionFlagsBits.ViewChannel] },
        { id: roles.owner.id, allow: [PermissionFlagsBits.ViewChannel] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
    ];
    const ADMIN_ONLY_OW = [
        { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
        { id: roles.admin.id, allow: [PermissionFlagsBits.ViewChannel] },
        { id: roles.owner.id, allow: [PermissionFlagsBits.ViewChannel] },
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
    const catUpdates   = await findOrCreateCategory('📢 Updates', VERIFIED_ONLY_OW);
    const catCommunity = await findOrCreateCategory('💬 Community', VERIFIED_ONLY_OW);
    const catGaming    = await findOrCreateCategory('🎮 Gaming', VERIFIED_ONLY_OW);
    const catLive      = await findOrCreateCategory('🔴 Live Streamers', [
        { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
        { id: roles.verified.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
        { id: roles.liveStreamer.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.Stream] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] },
    ]);
    const catVoice     = await findOrCreateCategory('🔊 Voice Hub', VERIFIED_ONLY_OW);
    const catStaff     = await findOrCreateCategory('🔧 Staff', STAFF_ONLY_OW);
    const catLogs      = await findOrCreateCategory('📜 Logs', ADMIN_ONLY_OW);

    // Information (public)
    const chWelcome = await findOrCreateChannel('welcome', ChannelType.GuildText, catInfo, [
        { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
        { id: botId, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
    ]);
    const chRules = await findOrCreateChannel('rules', ChannelType.GuildText, catInfo, [
        { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: botId, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ]);
    const chRoles = await findOrCreateChannel('roles', ChannelType.GuildText, catInfo, [
        { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: botId, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ]);

    // Updates
    const chAnnouncements = await findOrCreateChannel('announcements', ChannelType.GuildText, catUpdates);
    const chLiveAnnounce  = await findOrCreateChannel('live-announcements', ChannelType.GuildText, catUpdates);

    // Community
    const chGeneral   = await findOrCreateChannel('general', ChannelType.GuildText, catCommunity);
    const chMedia     = await findOrCreateChannel('media', ChannelType.GuildText, catCommunity);
    const chSelfPromo = await findOrCreateChannel('self-promo', ChannelType.GuildText, catCommunity);

    // Gaming — Arc Raiders gated additionally to the role
    const chArcRaiders = await findOrCreateChannel('arc-raiders', ChannelType.GuildText, catGaming, [
        { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
        { id: roles.arcRaiders.id, allow: [PermissionFlagsBits.ViewChannel] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
    ]);

    // Live Streamers (voice)
    const chLiveLounge = await findOrCreateChannel('🔴 Live Lounge', ChannelType.GuildVoice, catLive);
    const chLiveCreate = await findOrCreateChannel('➕ Create Live VC', ChannelType.GuildVoice, catLive);

    // Voice Hub
    const chGeneralVC = await findOrCreateChannel('🔊 General VC', ChannelType.GuildVoice, catVoice);
    const chCreateVC  = await findOrCreateChannel('➕ Create VC', ChannelType.GuildVoice, catVoice);

    // Staff
    const chModChat = await findOrCreateChannel('mod-chat', ChannelType.GuildText, catStaff);
    const chModLogs = await findOrCreateChannel('mod-logs', ChannelType.GuildText, catStaff);

    // Logs
    const chMemberLog  = await findOrCreateChannel('member-log',  ChannelType.GuildText, catLogs);
    const chMessageLog = await findOrCreateChannel('message-log', ChannelType.GuildText, catLogs);
    const chVoiceLog   = await findOrCreateChannel('voice-log',   ChannelType.GuildText, catLogs);
    const chChannelLog = await findOrCreateChannel('channel-log', ChannelType.GuildText, catLogs);
    const chRoleLog    = await findOrCreateChannel('role-log',    ChannelType.GuildText, catLogs);
    const chServerLog  = await findOrCreateChannel('server-log',  ChannelType.GuildText, catLogs);
    const chAutomodLog = await findOrCreateChannel('automod-log', ChannelType.GuildText, catLogs);

    configured.push('8 categories, ~20 channels');

    // ═══ 3. Apply Muted role denies on every text channel ═══
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

    // guild_config (legacy prefix/language baseline)
    await pool.execute(
        'INSERT INTO guild_config (guild_id, prefix, language) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE guild_id = guild_id',
        [GUILD_ID, '!', 'en']
    ).catch(() => {});

    // guilds (canonical guild row used by stream-manager — live_role_id)
    await pool.execute(
        `INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id, use_webhook_persona)
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), live_role_id = VALUES(live_role_id)`,
        [GUILD_ID, chLiveAnnounce.id, roles.liveStreamer.id]
    ).catch(e => log(`  ! guilds insert failed: ${e.message}`));

    // verify_config — drives the rules-button gate
    await pool.execute(
        `INSERT INTO verify_config (guild_id, verified_role_id, unverified_role_id, gate_channel_id, enabled, unverified_kick_days)
         VALUES (?, ?, NULL, ?, 1, 0)
         ON DUPLICATE KEY UPDATE verified_role_id = VALUES(verified_role_id), gate_channel_id = VALUES(gate_channel_id), enabled = 1`,
        [GUILD_ID, roles.verified.id, chRules.id]
    ).catch(e => log(`  ! verify_config failed: ${e.message}`));
    log('  ✓ verify_config');

    // welcome_settings
    await pool.execute(
        `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message = VALUES(message), banner_enabled = 1`,
        [GUILD_ID, chWelcome.id, `{mention} — welcome to **${guild.name}**! Read <#${chRules.id}> and click ✅ I Agree to unlock the rest of the server.`]
    ).catch(e => log(`  ! welcome_settings failed: ${e.message}`));
    log('  ✓ welcome_settings');

    // self_promo_config
    await pool.execute(
        `INSERT INTO self_promo_config
            (guild_id, enabled, channel_id, allowed_platforms, auto_subscribe, delete_invalid, dm_on_track, dm_on_already_tracked, announcement_channel_id, same_channel)
         VALUES (?, 1, ?, ?, 1, 1, 1, 0, ?, 0)
         ON DUPLICATE KEY UPDATE enabled = 1, channel_id = VALUES(channel_id), allowed_platforms = VALUES(allowed_platforms),
            announcement_channel_id = VALUES(announcement_channel_id)`,
        [GUILD_ID, chSelfPromo.id, JSON.stringify(['twitch','kick','youtube','tiktok']), chLiveAnnounce.id]
    ).catch(e => log(`  ! self_promo_config failed: ${e.message}`));
    log('  ✓ self_promo_config');

    // guild_streamer_auto_track — Live Streamer role triggers an announcement in #live-announcements
    await pool.execute(
        `INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, enabled, delete_on_end, edit_on_end)
         VALUES (?, ?, ?, 1, 0, 1)
         ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), announcement_channel_id = VALUES(announcement_channel_id), enabled = 1`,
        [GUILD_ID, roles.liveStreamer.id, chLiveAnnounce.id]
    ).catch(e => log(`  ! guild_streamer_auto_track failed: ${e.message}`));
    log('  ✓ guild_streamer_auto_track');

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

    // moderation_config (mod_log channel + muted role)
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

    // Temp VC creators × 2
    await pool.execute(
        `INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template, required_role_id, default_user_limit)
         VALUES (?, ?, ?, ?, NULL, NULL)
         ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), naming_template = VALUES(naming_template), required_role_id = NULL, default_user_limit = NULL`,
        [GUILD_ID, chCreateVC.id, catVoice.id, "{user}'s VC"]
    ).catch(e => log(`  ! temp VC (regular) failed: ${e.message}`));
    await pool.execute(
        `INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template, required_role_id, default_user_limit)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), naming_template = VALUES(naming_template), required_role_id = VALUES(required_role_id)`,
        [GUILD_ID, chLiveCreate.id, catLive.id, "🔴 {user}'s Live Room", roles.liveStreamer.id]
    ).catch(e => log(`  ! temp VC (live) failed: ${e.message}`));
    log('  ✓ temp_channel_config (2 creators: regular + live-only)');

    // ═══ 5. Embeds + reaction-role panels ═══
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
                { name: '2. Don\'t be a Dick', value: 'No harassment, hate speech, doxxing, slurs, or aggressive trolling. We don\'t care if it was "just a joke".' },
                { name: '3. No Spam / NSFW Outside Marked Channels', value: 'Mass pings, raids, NSFW dumps, malicious links — instant ban.' },
                { name: '4. Staff Has Final Say', value: 'Mods can take action even when something isn\'t explicitly listed. Catch-all.' },
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

    // 5b. Notifications panel + 5c. Games panel
    const styleName = (s) => ({
        [ButtonStyle.Primary]:   'primary',
        [ButtonStyle.Secondary]: 'secondary',
        [ButtonStyle.Success]:   'success',
        [ButtonStyle.Danger]:    'danger',
    }[s] || 'primary');
    async function deployRolePanel({ panelName, title, description, color, fields, mappings }) {
        const oldMessages = await chRoles.messages.fetch({ limit: 50 }).catch(() => null);
        // Don't blanket-purge here — multiple panels live in #roles. Caller is responsible for ordering.

        const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
        if (fields?.length) embed.addFields(fields);

        const row = new ActionRowBuilder().addComponents(
            ...mappings.map(m =>
                new ButtonBuilder()
                    .setCustomId(`rr_${m.roleId}`)
                    .setLabel(m.label)
                    .setStyle(m.style || ButtonStyle.Secondary)
                    .setEmoji(m.emoji || undefined)
            )
        );

        const msg = await chRoles.send({ embeds: [embed], components: [row] });

        await pool.execute(
            `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
             VALUES (?, ?, ?, ?, ?, ?, 'button', 'standard')
             ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), channel_id = VALUES(channel_id), embed_color = VALUES(embed_color)`,
            [GUILD_ID, chRoles.id, msg.id, panelName, description, color]
        );
        const [[p]] = await pool.execute(
            `SELECT id FROM reaction_role_panels WHERE guild_id = ? AND panel_name = ? ORDER BY id DESC LIMIT 1`,
            [GUILD_ID, panelName]
        );
        if (!p) return msg.id;

        // Reset mappings for this panel and reseed
        await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [p.id]);
        for (const m of mappings) {
            await pool.execute(
                `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?, ?, ?, ?, ?)`,
                [p.id, m.roleId, m.emoji || null, m.label, styleName(m.style)]
            );
        }
        return msg.id;
    }

    // Purge #roles once before deploying both panels
    try {
        const oldMessages = await chRoles.messages.fetch({ limit: 50 });
        if (oldMessages.size) await chRoles.bulkDelete(oldMessages, true).catch(() => {});
    } catch {}

    try {
        const notifMsgId = await deployRolePanel({
            panelName: 'notifications',
            title: '🔔 Notification Roles',
            description: 'Click a button to toggle. Get pinged when stuff happens.',
            color: '#3498DB',
            fields: [
                { name: '📢 Announcements', value: 'Server announcements & updates', inline: true },
                { name: '🎉 Giveaways', value: 'Get pinged for giveaways', inline: true },
                { name: '🔔 Stream Pings', value: 'Get pinged when streamers go live', inline: true },
            ],
            mappings: [
                { roleId: roles.announce.id,    label: 'Announcements', emoji: '📢', style: ButtonStyle.Primary },
                { roleId: roles.giveaways.id,   label: 'Giveaways',     emoji: '🎉', style: ButtonStyle.Primary },
                { roleId: roles.streamPings.id, label: 'Stream Pings',  emoji: '🔔', style: ButtonStyle.Primary },
            ],
        });
        log(`  ✓ Notifications panel posted (${notifMsgId})`);
        configured.push('Notifications panel');
    } catch (e) { log(`  ! Notifications panel failed: ${e.message}`); }

    try {
        const gamesMsgId = await deployRolePanel({
            panelName: 'games',
            title: '🎮 Game Roles',
            description: 'Pick the games you play to unlock those channels.',
            color: '#8E44AD',
            mappings: [
                { roleId: roles.arcRaiders.id, label: 'Arc Raiders', emoji: '🎮', style: ButtonStyle.Secondary, description: 'Unlocks #arc-raiders' },
            ],
        });
        log(`  ✓ Games panel posted (${gamesMsgId})`);
        configured.push('Games panel');
    } catch (e) { log(`  ! Games panel failed: ${e.message}`); }

    // ═══ 6. Verification block ═══
    log('\nStep 6: Verification');
    const verify = async (sql, params, label) => {
        const [r] = await pool.execute(sql, params);
        const n = Array.isArray(r) ? r[0]?.n ?? 0 : 0;
        log(`  ${n > 0 ? '✓' : '!'} ${label}: ${n}`);
        return n;
    };
    await verify('SELECT COUNT(*) AS n FROM verify_config WHERE guild_id = ?',           [GUILD_ID], 'verify_config rows');
    await verify('SELECT COUNT(*) AS n FROM logging_config WHERE guild_id = ?',          [GUILD_ID], 'logging_config rows');
    await verify('SELECT COUNT(*) AS n FROM log_event_config WHERE guild_id = ?',        [GUILD_ID], 'log_event_config rows');
    await verify('SELECT COUNT(*) AS n FROM reaction_role_panels WHERE guild_id = ?',    [GUILD_ID], 'reaction_role_panels rows');
    await verify('SELECT COUNT(*) AS n FROM temp_channel_config WHERE guild_id = ?',     [GUILD_ID], 'temp_channel_config rows');
    await verify('SELECT COUNT(*) AS n FROM anti_nuke_config WHERE guild_id = ? AND enabled = 1',       [GUILD_ID], 'anti_nuke_config enabled');
    await verify('SELECT COUNT(*) AS n FROM raid_detection_config WHERE guild_id = ? AND enabled = 1',  [GUILD_ID], 'raid_detection_config enabled');
    await verify('SELECT COUNT(*) AS n FROM phishing_config WHERE guild_id = ? AND enabled = 1',        [GUILD_ID], 'phishing_config enabled');
    await verify('SELECT COUNT(*) AS n FROM adaptive_spam_config WHERE guild_id = ? AND enabled = 1',   [GUILD_ID], 'adaptive_spam_config enabled');
    await verify('SELECT COUNT(*) AS n FROM guild_streamer_auto_track WHERE guild_id = ? AND enabled = 1', [GUILD_ID], 'guild_streamer_auto_track enabled');

    // ═══ Summary ═══
    console.log('\n' + '═'.repeat(60));
    console.log(`SETUP COMPLETE — ${guild.name}`);
    console.log('═'.repeat(60));
    configured.forEach(c => console.log(`  [OK] ${c}`));
    console.log('\nManual TODOs:');
    console.log(`  1. node scripts/deploy-commands-to-bot.js ${BOT_ID}`);
    console.log('  2. pm2 restart CertiFriedUtility');
    console.log(`  3. In Server Settings → Roles, drag the bot's role above ALL assignable roles (Verified, Live Streamer, Arc Raiders, notification roles)`);
    console.log('  4. Test: alt account joins → only #welcome / #rules / #roles visible → click ✅ I Agree → Verified granted → community channels appear');
    console.log('  5. Add Twitch/YouTube subscriptions via /social-streamer setup once you have streamers');
    console.log('═'.repeat(60));

    client.destroy();
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
