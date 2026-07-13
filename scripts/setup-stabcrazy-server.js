/**
 * Setup script for StabCrazy server (guild 980331356196311070)
 * Full migration replacing MEE6, Tickets, Uzox, Lurker.tv, and Daily Quotes
 *
 * Channels being replaced are cloned for a clean slate (no leftover messages).
 * User content in social/advertising channels is left untouched.
 *
 * Run AFTER audit-stabcrazy-server.js produces stabcrazy-audit-result.json
 * Stop PM2 before running: pm2 stop CertiFriedUtility
 *
 * Usage: node scripts/setup-stabcrazy-server.js
 */
import dotenv from 'dotenv';
dotenv.config();
import {
    Client, GatewayIntentBits, ChannelType,
    PermissionFlagsBits,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder
} from 'discord.js';
import { readFile } from 'fs/promises';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '980331356196311070';
const BOT_ID = '1482157000426258493';
const STABCRAZY_ID = '274331594280665088';
const SOCIAL_LIVE_CATEGORY = '980331357391695883';
const DAILY_QUOTES_BOT_ID = '880237210484506675';

// Channel IDs from audit
const CH = {
    rules: '980339550742257724',
    verify: '980331356695433280',
    verifyCategory: '980331356695433279',
    welcome: '980331356695433282',
    suggestions: '980331356926148659',
    votes: '980331356926148662',
    giveaways: '980331356926148660',
    logs: '980331357785972765',
    techSupport: '984095740525678602',
    levelUp: '980331357391695889',
    songRequest: '980331357785972760',
    botCommands: '980331357391695888',
    quoteOfDay: '988284822248108072',
    spoticord: '1019022883336491059',
    songRequests: '1019023432404447232',
    staffChat: '980331358029246474',
    support: '980339550742257725',
    lurkertvGoLive: '985292457279356938',
    modCategory: '980331357785972764',
};

// Role IDs from audit
const ROLES = {
    verified: '980331356196311077',
    liveNow: '985304307400310834',
    twitchStreamer: '980331356246638610',
    serverStaff: '980331356267626516',
    moderator: '980331356267626518',
    headMod: '980331356267626519',
    admin: '980331356267626520',
    headAdmin: '980331356267626521',
    level0: '980331356196311078',
    level10: '980331356196311079',
    level20: '980331356217311272',
    level40: '980331356217311273',
    level60: '980331356217311274',
    level80: '980331356217311275',
    level100: '980331356217311276',
};

const STAT_CHANNELS = {
    members: '985355979581448212',
    humans: '985356099639181363',
    bots: '985356014989750282',
};

const NSFW_CHANNELS = [
    '1060771766890414180', // sexy-chat
    '980331357559464009',  // 🔞｜nsfw
    '1012611865148391474', // 🚬Smoke Session🚬
    '984276972953804842',  // 🚬Smoke Session🚬 (live on twitch)
    '1198756267779428455', // the hidden society
];

const NOISE_USERNAMES = new Set(['i', 'invites', 'watch', 'live', 'embed', 'shorts', 'c', 'status']);

/**
 * Clone a channel for a clean slate, then delete the original.
 * Returns the new channel with identical settings but zero messages.
 */
async function cloneAndReplace(guild, channelId, reason) {
    const old = guild.channels.cache.get(channelId);
    if (!old) return null;

    const pos = old.position;
    const newCh = await old.clone({ reason });
    await old.delete(reason);
    await newCh.setPosition(pos).catch(() => {});

    // Re-cache
    guild.channels.cache.set(newCh.id, newCh);
    return newCh;
}

async function setup() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.error('Bot not found'); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) { console.error('Guild not found'); client.destroy(); await pool.end(); process.exit(1); }
    console.log(`Connected to: ${guild.name}`);

    await guild.channels.fetch();
    await guild.roles.fetch();
    await guild.members.fetch();

    const configured = [];
    const manual = [];

    // =========================================================================
    // STEP 1: Guild Config
    // =========================================================================
    console.log('\n=== STEP 1: Guild Config ===');
    try {
        await pool.execute(
            `INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id, use_webhook_persona)
             VALUES (?, NULL, ?, 0)
             ON DUPLICATE KEY UPDATE use_webhook_persona = 0, live_role_id = VALUES(live_role_id)`,
            [GUILD_ID, ROLES.liveNow]
        );
        console.log(`Bot-direct mode, live_role: LIVE NOW (${ROLES.liveNow})`);
        configured.push('Guild config');
    } catch (err) {
        console.error('Step 1 failed:', err.message);
    }

    // =========================================================================
    // STEP 2: Create #automated-live
    // =========================================================================
    console.log('\n=== STEP 2: #automated-live ===');
    let announcementChannelId = null;
    try {
        let ch = guild.channels.cache.find(
            c => c.name === 'automated-live' && c.parentId === SOCIAL_LIVE_CATEGORY && c.type === ChannelType.GuildText
        );
        if (!ch) {
            ch = await guild.channels.create({
                name: 'automated-live',
                type: ChannelType.GuildText,
                parent: SOCIAL_LIVE_CATEGORY,
                permissionOverwrites: [
                    { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.MentionEveryone, PermissionFlagsBits.EmbedLinks] }
                ]
            });
            console.log(`Created: ${ch.id}`);
        } else {
            console.log(`Exists: ${ch.id}`);
            const perms = ch.permissionsFor(client.user);
            if (!perms.has(PermissionFlagsBits.MentionEveryone)) {
                await ch.permissionOverwrites.edit(client.user.id, { SendMessages: true, MentionEveryone: true, EmbedLinks: true });
            }
        }
        announcementChannelId = ch.id;
        await pool.execute('UPDATE guilds SET announcement_channel_id = ? WHERE guild_id = ?', [announcementChannelId, GUILD_ID]);
        configured.push(`#automated-live (${announcementChannelId})`);
    } catch (err) {
        console.error('Step 2 failed:', err.message);
        manual.push('#automated-live channel');
    }

    // =========================================================================
    // STEP 3: Import Streamers
    // =========================================================================
    console.log('\n=== STEP 3: Import Streamers ===');
    let auditData = null;
    try {
        const raw = await readFile(new URL('./stabcrazy-audit-result.json', import.meta.url), 'utf-8');
        auditData = JSON.parse(raw);
        const list = (auditData.streamerList || []).filter(s =>
            s.platform && s.username && !NOISE_USERNAMES.has(s.username.toLowerCase())
        );
        console.log(`${list.length} streamers (noise filtered)`);

        let created = 0, existing = 0;
        for (const { platform, username } of list) {
            const [rows] = await pool.execute(
                'SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = LOWER(?)',
                [platform, username]
            );
            let streamerId;
            if (rows.length) { streamerId = rows[0].streamer_id; existing++; }
            else {
                const [r] = await pool.execute(
                    'INSERT INTO streamers (platform, username, platform_user_id) VALUES (?, ?, ?)',
                    [platform, username, `temp_${username}_${Date.now()}`]
                );
                streamerId = r.insertId; created++;
            }
            await pool.execute(
                `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, live_role_id, delete_on_end, edit_on_end)
                 VALUES (?, ?, ?, ?, 1, 1)
                 ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), live_role_id = VALUES(live_role_id), delete_on_end = 1, edit_on_end = 1`,
                [GUILD_ID, streamerId, announcementChannelId, ROLES.liveNow]
            );
        }
        console.log(`  Created: ${created}, Existing: ${existing}`);
        configured.push(`${list.length} streamers imported`);
    } catch (err) {
        console.error('Step 3 failed:', err.message);
        manual.push('Streamer import');
    }

    // =========================================================================
    // STEP 4: StabCrazy @everyone Ping
    // =========================================================================
    console.log('\n=== STEP 4: StabCrazy @everyone ===');
    try {
        if (!auditData) throw new Error('No audit data');
        const scStreamers = (auditData.streamerList || []).filter(
            s => s.isStabCrazy && s.username && !NOISE_USERNAMES.has(s.username.toLowerCase())
        );
        for (const { platform, username } of scStreamers) {
            const [rows] = await pool.execute(
                'SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = LOWER(?)',
                [platform, username]
            );
            if (!rows.length) continue;
            await pool.execute('UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?', [STABCRAZY_ID, rows[0].streamer_id]);
            await pool.execute(
                'UPDATE subscriptions SET custom_message = ? WHERE guild_id = ? AND streamer_id = ?',
                ['@everyone {username} is LIVE on {platform}! {url}', GUILD_ID, rows[0].streamer_id]
            );
            console.log(`  ${platform}/${username} -> @everyone ping`);
        }
        configured.push(`StabCrazy @everyone: ${scStreamers.length} streamers`);
    } catch (err) {
        console.error('Step 4 failed:', err.message);
    }

    // =========================================================================
    // STEP 5: Live Role Check
    // =========================================================================
    console.log('\n=== STEP 5: Live Role Hierarchy ===');
    try {
        const liveRole = guild.roles.cache.get(ROLES.liveNow);
        const bot = guild.members.cache.get(client.user.id);
        if (liveRole && bot) {
            const ok = bot.roles.highest.position > liveRole.position;
            console.log(`LIVE NOW pos=${liveRole.position}, Bot pos=${bot.roles.highest.position} → ${ok ? 'OK' : 'NEEDS FIX'}`);
            if (!ok) manual.push('Move bot role above LIVE NOW');
            else configured.push('Live role hierarchy OK');
        }
    } catch (err) {
        console.error('Step 5 failed:', err.message);
    }

    // =========================================================================
    // STEP 6: Logging — Proper Category + Routed Channels
    // =========================================================================
    console.log('\n=== STEP 6: Logging ===');
    try {
        const modCat = guild.channels.cache.get(CH.modCategory);
        let logCat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && /^\✴.*logs/i.test(c.name));

        if (!logCat) {
            logCat = await guild.channels.create({
                name: '✴|〔 LOGS 〕|✴',
                type: ChannelType.GuildCategory,
                position: modCat ? modCat.position + 1 : undefined,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: ROLES.serverStaff, allow: [PermissionFlagsBits.ViewChannel] },
                    { id: ROLES.moderator, allow: [PermissionFlagsBits.ViewChannel] },
                    { id: ROLES.headMod, allow: [PermissionFlagsBits.ViewChannel] },
                    { id: ROLES.admin, allow: [PermissionFlagsBits.ViewChannel] },
                    { id: ROLES.headAdmin, allow: [PermissionFlagsBits.ViewChannel] },
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
                ]
            });
            console.log(`Created category: ${logCat.id}`);
        }

        const defs = [
            { name: 'member-logs', events: ['member_join', 'member_leave', 'member_update', 'member_ban', 'member_unban'] },
            { name: 'message-logs', events: ['message_delete', 'message_edit', 'message_bulk_delete'] },
            { name: 'mod-logs', events: ['moderation_action'] },
            { name: 'server-logs', events: ['role_create', 'role_delete', 'role_update', 'channel_create', 'channel_delete', 'channel_update', 'emoji_create', 'emoji_delete'] },
            { name: 'voice-logs', events: ['voice_join', 'voice_leave', 'voice_move'] },
            { name: 'invite-logs', events: ['invite_create', 'invite_delete'] },
        ];

        const logChannels = {};
        for (const d of defs) {
            let ch = guild.channels.cache.find(c => c.name === d.name && c.parentId === logCat.id);
            if (!ch) {
                ch = await guild.channels.create({ name: d.name, type: ChannelType.GuildText, parent: logCat.id });
                console.log(`  Created #${d.name}: ${ch.id}`);
            }
            logChannels[d.name] = ch.id;
        }

        const allEvents = defs.flatMap(d => d.events);
        await pool.execute(
            `INSERT INTO logging_config (guild_id, log_channel_id, enabled_events, enabled)
             VALUES (?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), enabled_events = VALUES(enabled_events), enabled = 1`,
            [GUILD_ID, logChannels['member-logs'], JSON.stringify(allEvents)]
        );

        for (const d of defs) {
            for (const event of d.events) {
                await pool.execute(
                    `INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id)
                     VALUES (?, ?, 1, ?)
                     ON DUPLICATE KEY UPDATE enabled = 1, log_channel_id = VALUES(log_channel_id)`,
                    [GUILD_ID, event, logChannels[d.name]]
                );
            }
        }
        configured.push(`Logging: 6 channels, ${allEvents.length} events routed`);
    } catch (err) {
        console.error('Step 6 failed:', err.message);
        manual.push('Logging setup');
    }

    // =========================================================================
    // STEP 7: Clean #rules → Rules + Verify Embed
    // (Community server: rules channel can't be deleted, so purge messages instead)
    // =========================================================================
    console.log('\n=== STEP 7: Rules + Verify ===');
    let rulesChannel = null;
    try {
        rulesChannel = guild.channels.cache.get(CH.rules);
        if (!rulesChannel) throw new Error('#rules not found');

        // Purge old messages (community rules channel can't be cloned)
        let deleted;
        do {
            const msgs = await rulesChannel.messages.fetch({ limit: 100 });
            if (msgs.size === 0) break;
            // bulkDelete handles <14d msgs; individual delete for older
            deleted = await rulesChannel.bulkDelete(msgs, true).catch(() => null);
            const remaining = deleted ? msgs.size - deleted.size : msgs.size;
            if (remaining > 0) {
                const old = msgs.filter(m => !deleted || !deleted.has(m.id));
                for (const [, m] of old) await m.delete().catch(() => {});
            }
            console.log(`  Purged ${msgs.size} messages`);
        } while (deleted && deleted.size > 0);
        console.log(`Cleaned #rules: ${rulesChannel.id}`);

        const rulesEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('📜 Server Rules & Community Guidelines')
            .setDescription('Welcome to **The Stab Crazies**! By verifying below, you agree to follow these rules.')
            .addFields(
                {
                    name: '🛡️ Respect & Safety',
                    value: '**1.** No harassment or organized bullying.\n**2.** No hate speech based on protected attributes.\n**3.** No threats of violence or doxxing.\n**4.** No violent extremism.'
                },
                {
                    name: '🔞 Content Rules',
                    value: '**5.** Zero tolerance for child exploitation.\n**6.** Adult content in 18+ channels only.\n**7.** No NSFW avatars, banners, or emoji.\n**8.** No non-consensual intimate content.'
                },
                {
                    name: '⚖️ Integrity',
                    value: '**9.** No self-harm glorification.\n**10.** No real gore or animal harm.\n**11.** Respect intellectual property.\n**12.** No harmful misinformation.'
                },
                {
                    name: '🔒 Security & Fair Use',
                    value: '**13.** No malicious impersonation.\n**14.** No hacking, phishing, or DDOS.\n**15.** No piracy, stolen accounts, or cheats.\n**16.** No spam or fake engagement.'
                },
                {
                    name: '📋 Platform Rules',
                    value: '**17.** No illegal activity.\n**18.** No account/server trading.\n**19.** No self-bots or user-bots.\n**20.** No false reports to Discord.'
                },
                {
                    name: '⚠️ Enforcement',
                    value: `Violations handled at staff discretion. Report issues to <@&${ROLES.serverStaff}>.\n\n**Click below to verify and access the server.**`
                }
            )
            .setFooter({ text: 'The Stab Crazies' })
            .setTimestamp();

        const verifyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`rr_${ROLES.verified}`)
                .setLabel('✅ I Agree — Verify Me')
                .setStyle(ButtonStyle.Success)
        );

        const rulesMsg = await rulesChannel.send({ embeds: [rulesEmbed], components: [verifyRow] });
        console.log(`Rules + Verify posted: ${rulesMsg.id}`);

        // DB panel
        await pool.execute(
            `INSERT INTO reaction_role_panels
             (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
             VALUES (?, ?, ?, 'rules-verify', 'Server rules + verify', '#FF0000', 'button', 'standard')
             ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), channel_id = VALUES(channel_id)`,
            [GUILD_ID, rulesChannel.id, rulesMsg.id]
        );
        const [[panel]] = await pool.execute(
            'SELECT id FROM reaction_role_panels WHERE guild_id = ? AND panel_name = ? ORDER BY id DESC LIMIT 1',
            [GUILD_ID, 'rules-verify']
        );
        if (panel) {
            await pool.execute(
                `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji, label, description)
                 VALUES (?, ?, '✅', 'Verify', 'Agree to rules')
                 ON DUPLICATE KEY UPDATE label = VALUES(label)`,
                [panel.id, ROLES.verified]
            );
        }
        configured.push('Rules + Verify embed');
    } catch (err) {
        console.error('Step 7 failed:', err.message);
        manual.push('Rules + Verify embed');
    }

    // =========================================================================
    // STEP 8: 18+ NSFW Role + Panel (posted in rules channel)
    // =========================================================================
    console.log('\n=== STEP 8: NSFW 18+ Role ===');
    try {
        let nsfwRole = guild.roles.cache.find(r => r.name.includes('18+') || r.name.toLowerCase() === 'nsfw');
        if (!nsfwRole) {
            nsfwRole = await guild.roles.create({ name: '🔞 18+', color: 0xFF0000, reason: 'CertiFried: NSFW access role' });
            console.log(`Created role: ${nsfwRole.id}`);
        } else {
            console.log(`Found role: ${nsfwRole.name} (${nsfwRole.id})`);
        }

        // Lock NSFW channels to this role
        for (const chId of NSFW_CHANNELS) {
            const ch = guild.channels.cache.get(chId);
            if (!ch) continue;
            await ch.permissionOverwrites.edit(guild.id, { ViewChannel: false });
            await ch.permissionOverwrites.edit(nsfwRole.id, { ViewChannel: true });
            await ch.permissionOverwrites.edit(client.user.id, { ViewChannel: true, SendMessages: true });
            console.log(`  Locked #${ch.name}`);
        }

        // Post 18+ verify panel in #rules (below the rules embed)
        const targetChannel = rulesChannel || guild.channels.cache.get(CH.rules);
        if (targetChannel) {
            const nsfwEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('🔞 Age Verification')
                .setDescription('Click below to confirm you are **18+** and access NSFW channels.');

            const nsfwRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`rr_${nsfwRole.id}`)
                    .setLabel('🔞 I am 18+')
                    .setStyle(ButtonStyle.Danger)
            );
            const nsfwMsg = await targetChannel.send({ embeds: [nsfwEmbed], components: [nsfwRow] });

            await pool.execute(
                `INSERT INTO reaction_role_panels
                 (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
                 VALUES (?, ?, ?, 'nsfw-verify', '18+ age verification', '#FF0000', 'button', 'standard')
                 ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), channel_id = VALUES(channel_id)`,
                [GUILD_ID, targetChannel.id, nsfwMsg.id]
            );
            const [[nsfwPanel]] = await pool.execute(
                'SELECT id FROM reaction_role_panels WHERE guild_id = ? AND panel_name = ? ORDER BY id DESC LIMIT 1',
                [GUILD_ID, 'nsfw-verify']
            );
            if (nsfwPanel) {
                await pool.execute(
                    `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji, label)
                     VALUES (?, ?, '🔞', '18+ Access')
                     ON DUPLICATE KEY UPDATE label = VALUES(label)`,
                    [nsfwPanel.id, nsfwRole.id]
                );
            }
            console.log(`18+ panel in #rules: ${nsfwMsg.id}`);
        }
        configured.push(`NSFW: ${nsfwRole.name} role + ${NSFW_CHANNELS.length} channels locked`);
    } catch (err) {
        console.error('Step 8 failed:', err.message);
        manual.push('NSFW 18+ role setup');
    }

    // =========================================================================
    // STEP 9: Delete #verify (replaced by rules+verify)
    // =========================================================================
    console.log('\n=== STEP 9: Remove #verify ===');
    try {
        const verify = guild.channels.cache.get(CH.verify);
        if (verify) {
            await verify.delete('CertiFried: combined into #rules');
            console.log('Deleted #verify');
            // Also remove empty verify category
            const verifyCat = guild.channels.cache.get(CH.verifyCategory);
            if (verifyCat) {
                const children = guild.channels.cache.filter(c => c.parentId === verifyCat.id);
                if (children.size === 0) {
                    await verifyCat.delete('CertiFried: empty category after verify removal');
                    console.log('Deleted empty VERIFICATION category');
                }
            }
        }
        configured.push('Removed #verify + empty category');
    } catch (err) {
        console.error('Step 9 failed:', err.message);
        manual.push('Delete #verify channel');
    }

    // =========================================================================
    // STEP 10: Stat Display Channels
    // =========================================================================
    console.log('\n=== STEP 10: Stat Display ===');
    try {
        const stats = [
            { channelId: STAT_CHANNELS.members, statType: 'members', template: 'Total Members: {value}' },
            { channelId: STAT_CHANNELS.humans, statType: 'humans', template: 'Humans: {value}' },
            { channelId: STAT_CHANNELS.bots, statType: 'bots', template: 'Bots: {value}' },
        ];
        for (const s of stats) {
            await pool.execute(
                `INSERT INTO stat_display_channels (guild_id, channel_id, stat_type, template)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE stat_type = VALUES(stat_type), template = VALUES(template)`,
                [GUILD_ID, s.channelId, s.statType, s.template]
            );
            console.log(`  ${s.statType} -> ${s.channelId}`);
        }
        configured.push('Stat display: 3 channels');
    } catch (err) {
        console.error('Step 10 failed:', err.message);
        manual.push('Stat display channels');
    }

    // =========================================================================
    // STEP 11: Welcome
    // =========================================================================
    console.log('\n=== STEP 11: Welcome ===');
    try {
        const rulesRef = rulesChannel ? rulesChannel.id : CH.rules;
        await pool.execute(
            `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled)
             VALUES (?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message = VALUES(message), banner_enabled = 1`,
            [GUILD_ID, CH.welcome, `{mention} welcome to **The Stab Crazies**! Head to <#${rulesRef}> to verify.`]
        );
        console.log(`Welcome -> #welcome, pointing to <#${rulesRef}>`);
        configured.push('Welcome messages');
    } catch (err) {
        console.error('Step 11 failed:', err.message);
    }

    // =========================================================================
    // STEP 12: Leveling + ALL Level Rewards
    // =========================================================================
    console.log('\n=== STEP 12: Leveling ===');
    let levelChannel = null;
    try {
        // Clone #level for a clean slate (was full of MEE6 messages)
        levelChannel = await cloneAndReplace(guild, CH.levelUp, 'CertiFried: clean level-up channel');
        const levelChId = levelChannel ? levelChannel.id : CH.levelUp;
        console.log(`Cloned #level: ${levelChId}`);

        await pool.execute(
            `INSERT INTO level_config (guild_id, enabled, xp_per_message, xp_cooldown_seconds, level_up_channel_id)
             VALUES (?, 1, 15, 60, ?)
             ON DUPLICATE KEY UPDATE enabled = 1, xp_per_message = 15, xp_cooldown_seconds = 60, level_up_channel_id = VALUES(level_up_channel_id)`,
            [GUILD_ID, levelChId]
        );

        const rewards = [
            { level: 0,   roleId: ROLES.level0,   name: '⭐Viewer〔Level 0⁺〕' },
            { level: 10,  roleId: ROLES.level10,  name: '🌟Active Viewer〔Level 10⁺〕' },
            { level: 20,  roleId: ROLES.level20,  name: '✨Good Viewer〔Level 20⁺〕' },
            { level: 40,  roleId: ROLES.level40,  name: '🌠Ace Viewer〔Level 40⁺〕' },
            { level: 60,  roleId: ROLES.level60,  name: '🔱Legend Viewer〔Level 60⁺〕' },
            { level: 80,  roleId: ROLES.level80,  name: '⚜️Mythic Viewer〔Level 80⁺〕' },
            { level: 100, roleId: ROLES.level100, name: '💯 Godlike Viewer〔Level 100⁺〕' },
        ];

        for (const r of rewards) {
            await pool.execute(
                `INSERT INTO level_rewards (guild_id, level, role_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)`,
                [GUILD_ID, r.level, r.roleId]
            );
            console.log(`  Level ${String(r.level).padStart(3)} -> ${r.name}`);
        }
        configured.push('Leveling: 7 rewards (0, 10, 20, 40, 60, 80, 100)');
        manual.push('Import MEE6 XP data (API or screenshots)');
    } catch (err) {
        console.error('Step 12 failed:', err.message);
        manual.push('Leveling setup');
    }

    // =========================================================================
    // STEP 13: Suggestions
    // =========================================================================
    console.log('\n=== STEP 13: Suggestions ===');
    try {
        await pool.execute(
            `INSERT INTO suggestion_config (guild_id, suggestions_channel_id, enabled, allow_anonymous, require_approval)
             VALUES (?, ?, TRUE, TRUE, FALSE)
             ON DUPLICATE KEY UPDATE suggestions_channel_id = VALUES(suggestions_channel_id), enabled = TRUE`,
            [GUILD_ID, CH.suggestions]
        );
        console.log(`Suggestions enabled -> ${CH.suggestions}`);
        configured.push('Suggestions system');
    } catch (err) {
        console.error('Step 13 failed:', err.message);
    }

    // =========================================================================
    // STEP 14: Clone #vote (clean for polls)
    // =========================================================================
    console.log('\n=== STEP 14: Polls/Votes ===');
    try {
        const voteCh = await cloneAndReplace(guild, CH.votes, 'CertiFried: clean polls channel');
        if (voteCh) console.log(`Cloned #vote: ${voteCh.id}`);
        configured.push('Polls channel clean');
    } catch (err) {
        console.error('Step 14 failed:', err.message);
    }

    // =========================================================================
    // STEP 15: Ticketing — Clone #support + post in #tech-support
    // =========================================================================
    console.log('\n=== STEP 15: Ticketing ===');
    try {
        // Find or create ticket category
        let ticketCat = guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && /ticket/i.test(c.name)
        );
        if (!ticketCat) {
            ticketCat = await guild.channels.create({
                name: '✴|〔 TICKETS 〕|✴',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: ROLES.serverStaff, allow: [PermissionFlagsBits.ViewChannel] },
                    { id: ROLES.moderator, allow: [PermissionFlagsBits.ViewChannel] },
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
                ]
            });
            console.log(`Created ticket category: ${ticketCat.id}`);
        }

        // Helper: deploy a ticket panel in a channel
        async function deployTicketPanel(channel, panelName, title, desc, label, emoji, style) {
            await pool.execute(
                `INSERT INTO ticket_panels (guild_id, panel_channel_id, panel_name, embed_title, embed_description, button_text, button_emoji, ticket_category_id, support_role_id, save_transcripts)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE ticket_category_id = VALUES(ticket_category_id), support_role_id = VALUES(support_role_id), panel_channel_id = VALUES(panel_channel_id)`,
                [GUILD_ID, channel.id, panelName, title, desc, label, emoji, ticketCat.id, ROLES.serverStaff]
            );
            const [[p]] = await pool.execute(
                'SELECT panel_id FROM ticket_panels WHERE guild_id = ? AND panel_name = ? ORDER BY panel_id DESC LIMIT 1',
                [GUILD_ID, panelName]
            );
            if (!p) return;

            const embed = new EmbedBuilder().setColor(style === ButtonStyle.Primary ? 0x5865F2 : 0xFF8C00).setTitle(title).setDescription(desc);
            const btn = new ButtonBuilder().setCustomId(`ticket_create_${p.panel_id}`).setLabel(label).setEmoji(emoji).setStyle(style);
            const msg = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] });
            await pool.execute('UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [msg.id, p.panel_id]);
            return msg.id;
        }

        // Clone #support → deploy General Support panel
        const supportCh = await cloneAndReplace(guild, CH.support, 'CertiFried: clean support channel');
        if (supportCh) {
            const msgId = await deployTicketPanel(
                supportCh, 'General Support',
                '🎫 Support', 'Need help? Click below to open a support ticket.',
                'Open Support Ticket', '🎫', ButtonStyle.Primary
            );
            console.log(`Support panel in #support: ${msgId}`);
            configured.push('Support ticket panel');
        }

        // #tech-support is already empty → deploy Tech Support panel directly
        const techCh = guild.channels.cache.get(CH.techSupport);
        if (techCh) {
            const msgId = await deployTicketPanel(
                techCh, 'Tech Support',
                '🔧 Tech Support', 'Having a technical issue? Click below for help.',
                'Open Tech Ticket', '🔧', ButtonStyle.Secondary
            );
            console.log(`Tech panel in #tech-support: ${msgId}`);
            configured.push('Tech ticket panel');
        }
    } catch (err) {
        console.error('Step 15 failed:', err.message);
        manual.push('Ticketing setup');
    }

    // =========================================================================
    // STEP 16: Music Panel (channel already empty)
    // =========================================================================
    console.log('\n=== STEP 16: Music Panel ===');
    try {
        const musicCh = guild.channels.cache.get(CH.songRequest);
        if (musicCh) {
            const embed = new EmbedBuilder()
                .setColor(0x2B2D31)
                .setAuthor({ name: 'Live Music Player' })
                .setTitle('The queue is empty')
                .setDescription('Add a song using the dropdown menu below to get started.')
                .setThumbnail(client.user.displayAvatarURL())
                .setFooter({ text: 'Use the controls below to manage the music.' });

            const playbackRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('music-play-pause').setLabel('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId('music-skip').setLabel('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId('music-stop').setLabel('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true),
                new ButtonBuilder().setCustomId('music-clear').setLabel('🗑️').setStyle(ButtonStyle.Secondary).setDisabled(true),
            );

            const selectRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('music-add-song')
                    .setPlaceholder('Add a song or start a DJ')
                    .addOptions([
                        { label: 'Add song/playlist by name or URL', description: 'Add a song, YouTube playlist, or Spotify playlist', value: 'add_song_modal' },
                        { label: 'Start an AI DJ session', description: 'AI-generated playlist or play from a playlist link', value: 'start_dj_modal' }
                    ])
            );

            const msg = await musicCh.send({ embeds: [embed], components: [playbackRow, selectRow] });
            console.log(`Music panel in #${musicCh.name}: ${msg.id}`);
            configured.push('Music panel');
        }
    } catch (err) {
        console.error('Step 16 failed:', err.message);
        manual.push('Music panel');
    }

    // =========================================================================
    // STEP 17: Auto-Track
    // =========================================================================
    console.log('\n=== STEP 17: Auto-Track ===');
    try {
        if (announcementChannelId) {
            await pool.execute(
                `INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, enabled)
                 VALUES (?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), announcement_channel_id = VALUES(announcement_channel_id), enabled = 1`,
                [GUILD_ID, ROLES.twitchStreamer, announcementChannelId]
            );
            console.log(`🔴Twitch Streamer -> #automated-live`);
            configured.push('Auto-track: Twitch Streamer role');
        }
    } catch (err) {
        console.error('Step 17 failed:', err.message);
    }

    // =========================================================================
    // STEP 18: Remove Obsolete Channels
    // =========================================================================
    console.log('\n=== STEP 18: Remove Channels ===');
    const toRemove = [
        { id: CH.songRequests, name: 'song-requests' },
        { id: CH.spoticord, name: 'spoticord' },
        { id: CH.quoteOfDay, name: 'quote-of-the-day' },
        { id: CH.lurkertvGoLive, name: 'lurkertv-bot-go-live' },
    ];
    for (const { id, name } of toRemove) {
        try {
            const ch = guild.channels.cache.get(id);
            if (ch) { await ch.delete(`CertiFried: replaced by new systems`); console.log(`  Deleted #${name}`); }
        } catch (err) {
            console.error(`  Failed #${name}: ${err.message}`);
            manual.push(`Delete #${name}`);
        }
    }
    configured.push('Removed: song-requests, spoticord, quote-of-the-day, lurkertv-bot-go-live');

    // =========================================================================
    // STEP 19: Kick Daily Quotes Bot
    // =========================================================================
    console.log('\n=== STEP 19: Kick Daily Quotes ===');
    try {
        const dqBot = guild.members.cache.get(DAILY_QUOTES_BOT_ID);
        if (dqBot) {
            await dqBot.kick('CertiFried: bot no longer needed');
            console.log('Kicked Daily Quotes bot');
            configured.push('Kicked Daily Quotes');
        } else {
            console.log('Daily Quotes not in server');
        }
    } catch (err) {
        console.error('Step 19 failed:', err.message);
        manual.push('Kick Daily Quotes bot');
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '='.repeat(60));
    console.log('SETUP COMPLETE');
    console.log('='.repeat(60));

    console.log('\nConfigured:');
    configured.forEach(i => console.log(`  [OK] ${i}`));

    console.log('\nManual:');
    manual.push('Remove MEE6, Tickets, Uzox, Lurker.tv when ready');
    manual.push('Restart PM2: pm2 restart CertiFriedUtility');
    manual.forEach(i => console.log(`  [ ] ${i}`));

    console.log('\n' + '='.repeat(60));

    client.destroy();
    await pool.end();
    process.exit(0);
}

setup().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
