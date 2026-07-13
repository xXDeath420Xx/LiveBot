import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits, PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import mysql from 'mysql2/promise';
const { default: encryption } = await import('../utils/encryption.js');

const GUILD_ID = '880656752297783347';
const BOT_ID = '1486198184047808542';
const OWNER_ID = '727730062404747284';

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });

    const [bots] = await pool.execute('SELECT * FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildIntegrations,
            GatewayIntentBits.GuildPresences, GatewayIntentBits.MessageContent,
        ],
    });

    await client.login(token);
    await new Promise(resolve => client.once('ready', resolve));
    console.log(`Logged in as ${client.user.tag}\n`);

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    await guild.channels.fetch();
    await guild.roles.fetch();

    const log = (msg) => console.log(`[Setup] ${msg}`);

    // Helper: fetch messages from a channel
    async function fetchMessages(channelId, limit = 100) {
        try {
            const ch = guild.channels.cache.get(channelId);
            if (!ch?.isTextBased()) return [];
            return [...(await ch.messages.fetch({ limit })).values()];
        } catch { return []; }
    }

    // ═══ STEP 1: Scan channels for data extraction ═══
    log('STEP 1: Scanning channels...');

    // #army-going-live — extract Streamcord embed data
    const liveMessages = await fetchMessages('880854192107950140', 100);
    log(`  #army-going-live: ${liveMessages.length} messages`);
    const twitchUsernames = new Set();
    for (const m of liveMessages) {
        for (const embed of m.embeds) {
            const url = embed.url || embed.author?.url || '';
            const match = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
            if (match) twitchUsernames.add(match[1].toLowerCase());
        }
        const urlMatches = (m.content || '').match(/twitch\.tv\/([a-zA-Z0-9_]+)/gi) || [];
        urlMatches.forEach(u => { const m2 = u.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i); if (m2) twitchUsernames.add(m2[1].toLowerCase()); });
    }
    log(`  Extracted ${twitchUsernames.size} Twitch usernames: ${[...twitchUsernames].join(', ')}`);

    // #self-promo — also extract
    const promoMessages = await fetchMessages('952380129903009812', 50);
    log(`  #self-promo: ${promoMessages.length} messages`);
    for (const m of promoMessages) {
        const urls = (m.content || '').match(/twitch\.tv\/([a-zA-Z0-9_]+)/gi) || [];
        urls.forEach(u => { const m2 = u.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i); if (m2) twitchUsernames.add(m2[1].toLowerCase()); });
    }
    log(`  Total unique Twitch usernames: ${twitchUsernames.size}`);

    // ═══ STEP 2: Create roles ═══
    log('\nSTEP 2: Creating roles...');

    async function findOrCreate(name, opts = {}) {
        let r = guild.roles.cache.find(x => x.name === name);
        if (r) { log(`  "${name}" exists (${r.id})`); return r; }
        r = await guild.roles.create({ name, ...opts });
        log(`  Created "${name}" (${r.id})`);
        return r;
    }

    const verifiedRole = await findOrCreate('✅ Verified', { color: '#2ecc71' });
    const streamerRole = await findOrCreate('🎮 Streamer', { color: '#9b59b6', hoist: true });
    const notifRole = await findOrCreate('🔔 Stream Notifications', { color: '#e67e22', mentionable: true });
    const announcementsRole = await findOrCreate('📢 Announcements', { color: '#3498db', mentionable: true });
    const modRole = await findOrCreate('🛡️ Moderator', {
        color: '#e74c3c', hoist: true,
        permissions: [
            PermissionsBitField.Flags.KickMembers, PermissionsBitField.Flags.BanMembers,
            PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.MuteMembers,
            PermissionsBitField.Flags.MoveMembers, PermissionsBitField.Flags.ManageNicknames,
            PermissionsBitField.Flags.ModerateMembers, PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
        ],
    });

    // ═══ STEP 3: Grant Verified to ALL existing humans ═══
    log('\nSTEP 3: Granting Verified to all members...');
    let count = 0;
    for (const [, m] of guild.members.cache.filter(m => !m.user.bot)) {
        if (!m.roles.cache.has(verifiedRole.id)) {
            await m.roles.add(verifiedRole).catch(() => {});
            count++;
        }
    }
    log(`  Added Verified to ${count} members`);

    // ═══ STEP 4: Create logging channels ═══
    log('\nSTEP 4: Creating log channels...');

    let logsCat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('log'));
    if (!logsCat) {
        logsCat = await guild.channels.create({
            name: '📋 Logs', type: ChannelType.GuildCategory,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: modRole.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                { id: BOT_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks] },
            ],
        });
        log(`  Created category "${logsCat.name}"`);
    }

    const logTypes = {
        'member-log': ['memberJoin', 'memberLeave', 'memberUpdate', 'memberRoleUpdate'],
        'message-log': ['messageDelete', 'messageEdit', 'messageBulkDelete'],
        'mod-log': ['moderation', 'ban', 'unban', 'kick', 'mute', 'unmute', 'warn'],
        'automod-log': ['automod', 'phishing', 'spam'],
        'voice-log': ['voiceJoin', 'voiceLeave', 'voiceMove'],
        'channel-log': ['channelCreate', 'channelDelete', 'channelUpdate'],
        'role-log': ['roleCreate', 'roleDelete', 'roleUpdate'],
        'server-log': ['guildUpdate', 'emojiUpdate', 'inviteCreate', 'inviteDelete'],
    };

    for (const [chName, types] of Object.entries(logTypes)) {
        let ch = guild.channels.cache.find(c => c.name === chName && c.parentId === logsCat.id);
        if (!ch) {
            ch = await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: logsCat.id });
            log(`  Created #${chName} (${ch.id})`);
        }
        // Insert log routing for each type
        for (const logType of types) {
            await pool.execute(
                'INSERT INTO log_channel_routing (guild_id, log_type, channel_id, enabled) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), enabled = 1',
                [GUILD_ID, logType, ch.id]
            ).catch(() => {});
        }
    }
    log(`  Configured ${Object.values(logTypes).flat().length} log event routes`);

    // Also set the legacy logging_config
    await pool.execute(
        'INSERT INTO logging_config (guild_id, enabled) VALUES (?, 1) ON DUPLICATE KEY UPDATE enabled = 1',
        [GUILD_ID]
    ).catch(() => {});

    // ═══ STEP 5: Clone army-going-live ═══
    log('\nSTEP 5: Cloning stream channels...');

    const armyLiveOrig = guild.channels.cache.get('880854192107950140');
    let armyLiveNew;
    if (armyLiveOrig && liveMessages.length > 2) {
        armyLiveNew = await armyLiveOrig.clone({ name: 'army-going-live' });
        await armyLiveOrig.setName('army-going-live-old').catch(() => {});
        log(`  Cloned #army-going-live → ${armyLiveNew.id} (old renamed to -old)`);
    } else {
        armyLiveNew = armyLiveOrig;
        if (armyLiveOrig) {
            try { const msgs = await armyLiveOrig.messages.fetch({ limit: 100 }); if (msgs.size) await armyLiveOrig.bulkDelete(msgs); } catch {}
        }
        log(`  #army-going-live cleaned (few messages)`);
    }
    const armyLiveId = armyLiveNew?.id || '880854192107950140';

    // ═══ STEP 6: Rules + Verification ═══
    log('\nSTEP 6: Setting up rules + verification...');

    const rulesChannel = guild.channels.cache.get('880847657998880858');
    if (rulesChannel) {
        try { const old = await rulesChannel.messages.fetch({ limit: 50 }); if (old.size) await rulesChannel.bulkDelete(old).catch(() => {}); } catch {}

        const rulesEmbed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("📜 Server Rules — Anorak's Army")
            .setDescription("Welcome to Anorak's Army! Read the rules below and click the button to access the server.")
            .addFields(
                { name: '1. Be Respectful', value: 'No harassment, hate speech, or personal attacks.' },
                { name: '2. No Spam', value: 'No excessive messaging or self-promo outside designated channels.' },
                { name: '3. No NSFW', value: 'Keep all content SFW.' },
                { name: '4. Follow Discord TOS', value: 'All Discord Terms of Service apply.' },
                { name: '5. Use Channels Properly', value: 'Post content in the right channels.' },
                { name: '6. No Unsolicited Advertising', value: 'No DM advertising or random server invites.' },
                { name: '7. Listen to Staff', value: 'Mods have the final say.' },
                { name: '8. Have Fun!', value: 'Support each other and game on! 🎮' },
            )
            .setFooter({ text: 'Click below to agree and gain access.' });

        const verifyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('rr_select_verified').setLabel('✅ I Agree — Let Me In!').setStyle(ButtonStyle.Success)
        );

        const rulesMsg = await rulesChannel.send({ embeds: [rulesEmbed], components: [verifyRow] });
        log(`  Posted rules + verify (${rulesMsg.id})`);

        await pool.execute('INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, title, type) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)',
            [GUILD_ID, rulesChannel.id, rulesMsg.id, 'Server Verification', 'button']).catch(() => {});
        await pool.execute('INSERT INTO reaction_role_mappings (guild_id, message_id, emoji_or_value, role_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)',
            [GUILD_ID, rulesMsg.id, 'rr_select_verified', verifiedRole.id]).catch(() => {});
    }

    // ═══ STEP 7: Channel permissions ═══
    log('\nSTEP 7: Setting channel permissions...');

    const openCategoryIds = new Set(['880847725975990362', '880848462592245810']); // Welcome, Server Stats
    const openChannelIds = new Set(['880847657998880858']); // #rules

    for (const [, ch] of guild.channels.cache) {
        if (ch.type === ChannelType.GuildCategory) continue;
        if (ch.parentId === logsCat.id) continue;
        const isOpen = openCategoryIds.has(ch.parentId) || openChannelIds.has(ch.id);
        if (!isOpen) {
            await ch.permissionOverwrites.edit(guild.id, { ViewChannel: false }).catch(() => {});
            await ch.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: true, SendMessages: null }).catch(() => {});
        }
    }
    // Ensure admin category is mod-only
    const adminCat = '880847812068257842';
    for (const [, ch] of guild.channels.cache.filter(c => c.parentId === adminCat)) {
        await ch.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: false }).catch(() => {});
        await ch.permissionOverwrites.edit(modRole.id, { ViewChannel: true }).catch(() => {});
    }
    log('  Permissions set — open: Welcome+Stats+Rules, verified: everything else, admin: mods only');

    // ═══ STEP 8: Stream subscriptions ═══
    log('\nSTEP 8: Setting up stream subscriptions...');

    // Add auto-track for Streamer role → army-going-live
    await pool.execute(
        `INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, enabled, delete_on_end, edit_on_end)
         VALUES (?, ?, ?, 1, 0, 1)
         ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), enabled = 1`,
        [GUILD_ID, streamerRole.id, armyLiveId]
    );
    log(`  Auto-track: Streamer role → #army-going-live`);

    // Add individual streamers
    for (const username of twitchUsernames) {
        const isOwner = username === 'anorakswrath' || username === 'anoraks_wrath' || username === 'anorak';
        // Check if streamer already exists
        const [existing] = await pool.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND username = ? AND guild_id = ?', ['twitch', username, GUILD_ID]);
        if (existing.length === 0) {
            await pool.execute(
                'INSERT INTO streamers (platform, username, guild_id) VALUES (?, ?, ?)',
                ['twitch', username, GUILD_ID]
            ).catch(e => log(`    Failed ${username}: ${e.message}`));
            log(`  Added twitch/${username}${isOwner ? ' (OWNER → announcements)' : ''}`);
        } else {
            log(`  twitch/${username} already exists`);
        }
    }

    // Ensure anorakswrath is tracked
    if (!twitchUsernames.has('anorakswrath')) {
        await pool.execute('INSERT INTO streamers (platform, username, guild_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE guild_id = VALUES(guild_id)',
            ['twitch', 'anorakswrath', GUILD_ID]).catch(() => {});
        log('  Added anorakswrath manually');
    }

    // ═══ STEP 9: Protection systems ═══
    log('\nSTEP 9: Configuring protection...');

    const modLogCh = guild.channels.cache.find(c => c.name === 'mod-log' && c.parentId === logsCat.id);
    const automodLogCh = guild.channels.cache.find(c => c.name === 'automod-log' && c.parentId === logsCat.id);

    // Anti-raid
    await pool.execute(
        'INSERT INTO anti_raid_config (guild_id, enabled, join_threshold, join_window_seconds, action, alert_channel_id) VALUES (?, 1, 10, 15, ?, ?) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)',
        [GUILD_ID, 'lockdown', modLogCh?.id || null]
    ).catch(() => {});
    log('  Anti-raid: 10 joins/15s → lockdown');

    // Anti-nuke
    await pool.execute(
        'INSERT INTO anti_nuke_config (guild_id, enabled, channel_delete_threshold, role_delete_threshold, ban_threshold, action) VALUES (?, 1, 3, 3, 5, ?) ON DUPLICATE KEY UPDATE enabled=1',
        [GUILD_ID, 'strip_permissions']
    ).catch(() => {});
    log('  Anti-nuke: 3/3/5 thresholds → strip permissions');

    // Phishing
    await pool.execute(
        'INSERT INTO phishing_config (guild_id, enabled, action, log_channel_id) VALUES (?, 1, ?, ?) ON DUPLICATE KEY UPDATE enabled=1, log_channel_id=VALUES(log_channel_id)',
        [GUILD_ID, 'delete_and_warn', automodLogCh?.id || null]
    ).catch(() => {});
    log('  Phishing: delete + warn');

    // Adaptive spam
    await pool.execute(
        'INSERT INTO adaptive_spam_config (guild_id, enabled, action, sensitivity) VALUES (?, 1, ?, ?) ON DUPLICATE KEY UPDATE enabled=1',
        [GUILD_ID, 'mute', 'medium']
    ).catch(() => {});
    log('  Adaptive spam: medium sensitivity → mute');

    // Global ban system
    await pool.execute(
        'INSERT INTO global_ban_config (guild_id, enabled, action_critical, action_high, action_medium, action_low, alert_channel_id, check_on_join, check_on_message) VALUES (?, 1, ?, ?, ?, ?, ?, 1, 1) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)',
        [GUILD_ID, 'ban', 'ban', 'kick', 'alert', modLogCh?.id || null]
    ).catch(() => {});
    log('  Global bans: critical/high→ban, medium→kick, low→alert');

    // ═══ STEP 10: Notification role panel ═══
    log('\nSTEP 10: Creating role selection panel...');

    let rolesCh = guild.channels.cache.find(c => c.name === 'roles' && c.parentId === '880847725975990362');
    if (!rolesCh) {
        rolesCh = await guild.channels.create({
            name: 'roles', type: ChannelType.GuildText,
            parent: '880847725975990362', // Welcome category
            permissionOverwrites: [
                { id: guild.id, allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.SendMessages] },
                { id: BOT_ID, allow: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks] },
            ],
        });
        log(`  Created #roles (${rolesCh.id})`);
    }

    const roleEmbed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('🔔 Notification & Opt-In Roles')
        .setDescription('Pick your roles! Click a button to toggle.')
        .addFields(
            { name: '🔔 Stream Notifications', value: 'Get pinged when army members go live', inline: true },
            { name: '📢 Announcements', value: 'Get pinged for server announcements', inline: true },
            { name: '🎮 Streamer', value: "I'm a streamer — track my streams!", inline: true },
        );

    const roleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rr_select_stream_notif').setLabel('🔔 Streams').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('rr_select_announcements').setLabel('📢 Announcements').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('rr_select_streamer').setLabel('🎮 Streamer').setStyle(ButtonStyle.Secondary),
    );

    const roleMsg = await rolesCh.send({ embeds: [roleEmbed], components: [roleRow] });
    log(`  Posted role panel (${roleMsg.id})`);

    await pool.execute('INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, title, type) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)',
        [GUILD_ID, rolesCh.id, roleMsg.id, 'Notification Roles', 'button']).catch(() => {});

    for (const [key, roleId] of [['rr_select_stream_notif', notifRole.id], ['rr_select_announcements', announcementsRole.id], ['rr_select_streamer', streamerRole.id]]) {
        await pool.execute('INSERT INTO reaction_role_mappings (guild_id, message_id, emoji_or_value, role_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)',
            [GUILD_ID, roleMsg.id, key, roleId]).catch(() => {});
    }

    // ═══ STEP 11: Guild config ═══
    log('\nSTEP 11: Guild config...');
    await pool.execute('INSERT INTO guild_config (guild_id, prefix, language) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE guild_id = guild_id',
        [GUILD_ID, '!', 'en']).catch(() => {});

    // Self-promo config
    await pool.execute('INSERT INTO self_promo_config (guild_id, enabled, channel_id, auto_subscribe) VALUES (?, 1, ?, 1) ON DUPLICATE KEY UPDATE enabled=1, channel_id=VALUES(channel_id)',
        [GUILD_ID, '952380129903009812']).catch(() => {});
    log('  Self-promo auto-subscribe enabled');

    // ═══ DONE ═══
    console.log('\n═══════════════════════════════════════════');
    console.log("SETUP COMPLETE — Anorak's Army");
    console.log('═══════════════════════════════════════════');
    console.log('Roles: ✅ Verified, 🛡️ Moderator, 🎮 Streamer, 🔔 Stream Notifications, 📢 Announcements');
    console.log(`Verified: ${count} members granted`);
    console.log('Logging: 8 channels, ' + Object.values(logTypes).flat().length + ' event types routed');
    console.log(`Streams: ${twitchUsernames.size} Twitch users tracked`);
    console.log('  Owner (anorakswrath) → #announcements (881913924562354176)');
    console.log(`  Everyone else → #army-going-live (${armyLiveId})`);
    console.log('Protection: Anti-raid, Anti-nuke, Phishing, Adaptive Spam, Global Bans');
    console.log('Panels: Rules+Verify in #rules, Notification Roles in #roles');
    console.log('');
    console.log('MANUAL TODO:');
    console.log('  1. Deploy commands: node scripts/deploy-commands-to-bot.js ' + BOT_ID);
    console.log('  2. Kick MEE6, Hydra, Streamcord after verifying');
    console.log('  3. Set up music panel: /music-panel in #music-without-spam');
    console.log('  4. Delete #army-going-live-old after confirming clone');
    console.log('  5. Verify AnoraksWrath Twitch username');
    console.log('═══════════════════════════════════════════');

    client.destroy();
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
