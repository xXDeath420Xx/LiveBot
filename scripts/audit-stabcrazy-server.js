// Comprehensive read-only audit script for StabCrazy Discord server migration
// NO DB writes, NO channel creation, NO message sends

import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });
import { Client, GatewayIntentBits, ChannelType, PermissionsBitField } from 'discord.js';
import { writeFile } from 'fs/promises';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '980331356196311070';
const BOT_ID = '1482157000426258493';
const MEE6_ID = '159985870458322944';
const TICKETS_BOT_ID = '508391840525975553';
const UZOX_ID = '760027263046909992';
const LURKER_TV_ID = '377796671113003008';
const STABCRAZY_ID = '274331594280665088';
const SOCIAL_LIVE_CATEGORY = '980331357391695883';

const REPLACE_BOTS = new Set([MEE6_ID, TICKETS_BOT_ID, UZOX_ID, LURKER_TV_ID]);

const URL_REGEX = /https?:\/\/(?:www\.)?(?:twitch\.tv|kick\.com|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|twitter\.com|x\.com)[^\s<>"')\]]+/gi;

const PLATFORM_PATTERNS = [
    { platform: 'twitch', regex: /twitch\.tv\/(\w+)/i },
    { platform: 'kick', regex: /kick\.com\/(\w+)/i },
    { platform: 'youtube', regex: /youtube\.com\/@?([\w-]+)/i },
    { platform: 'tiktok', regex: /tiktok\.com\/@([\w.-]+)/i },
    { platform: 'instagram', regex: /instagram\.com\/([\w.-]+)/i },
    { platform: 'facebook', regex: /facebook\.com\/(?:gaming\/)?([\w.-]+)/i },
    { platform: 'twitter', regex: /(?:twitter\.com|x\.com)\/([\w]+)/i },
];

const DANGEROUS_PERMS = [
    'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels',
    'KickMembers', 'BanMembers', 'ManageWebhooks', 'ManageMessages',
    'MentionEveryone', 'ViewAuditLog'
];

const jsonResult = {};

function divider(title) {
    console.log('\n' + '='.repeat(80));
    console.log(`  ${title}`);
    console.log('='.repeat(80));
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function extractUrls(text) {
    if (!text) return [];
    const matches = text.match(URL_REGEX);
    return matches || [];
}

function parseStreamUrl(url) {
    // Filter out non-streamer URLs
    if (url.includes('discord.com') || url.includes('discordapp.com')) return null;
    for (const { platform, regex } of PLATFORM_PATTERNS) {
        const m = url.match(regex);
        if (m) {
            let username = m[1].toLowerCase();
            // Filter out generic youtube paths
            if (platform === 'youtube' && ['channel', 'watch', 'live', 'embed', 'playlist', 'shorts', 'c'].includes(username)) {
                // Try to get channel ID or live ID instead
                const channelMatch = url.match(/youtube\.com\/channel\/([\w-]+)/i);
                const liveMatch = url.match(/youtube\.com\/live\/([\w-]+)/i);
                if (channelMatch) return { platform: 'youtube', username: channelMatch[1] };
                if (liveMatch) return { platform: 'youtube', username: 'live/' + liveMatch[1] };
                return null;
            }
            return { platform, username };
        }
    }
    return null;
}

async function audit() {
    // Fetch bot token from DB
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) {
        console.error('Bot not found in custom_bots table');
        process.exit(1);
    }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildModeration,
            GatewayIntentBits.GuildEmojisAndStickers,
            GatewayIntentBits.GuildIntegrations,
            GatewayIntentBits.GuildWebhooks,
            GatewayIntentBits.GuildInvites,
            GatewayIntentBits.GuildPresences,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.AutoModerationConfiguration,
        ]
    });

    client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) {
        console.error('Guild not found');
        client.destroy();
        await pool.end();
        process.exit(1);
    }

    // Pre-fetch members and channels
    await guild.members.fetch();
    await guild.channels.fetch();
    await guild.roles.fetch();

    // ========================================================================
    // SECTION 1: Server Overview
    // ========================================================================
    try {
        divider('SECTION 1: Server Overview');
        const owner = await guild.fetchOwner();
        const overview = {
            name: guild.name,
            id: guild.id,
            owner: `${owner.user.tag} (${owner.id})`,
            created: guild.createdAt.toISOString(),
            verificationLevel: guild.verificationLevel,
            mfaLevel: guild.mfaLevel,
            boostLevel: guild.premiumTier,
            boostCount: guild.premiumSubscriptionCount,
            contentFilter: guild.explicitContentFilter,
            vanityUrl: guild.vanityURLCode || 'None',
            memberCount: guild.memberCount,
        };
        jsonResult.overview = overview;

        console.log(`  Name: ${overview.name}`);
        console.log(`  ID: ${overview.id}`);
        console.log(`  Owner: ${overview.owner}`);
        console.log(`  Created: ${overview.created}`);
        console.log(`  Verification Level: ${overview.verificationLevel}`);
        console.log(`  2FA Requirement: ${overview.mfaLevel}`);
        console.log(`  Boost Level: ${overview.boostLevel} (${overview.boostCount} boosts)`);
        console.log(`  Content Filter: ${overview.contentFilter}`);
        console.log(`  Vanity URL: ${overview.vanityUrl}`);
    } catch (err) {
        console.error('  Section 1 error:', err.message);
    }

    // ========================================================================
    // SECTION 2: Member Statistics
    // ========================================================================
    try {
        divider('SECTION 2: Member Statistics');
        const members = guild.members.cache;
        const humans = members.filter(m => !m.user.bot);
        const botMembers = members.filter(m => m.user.bot);
        const online = members.filter(m => m.presence?.status && m.presence.status !== 'offline');

        const stats = {
            total: members.size,
            humans: humans.size,
            bots: botMembers.size,
            botRatio: (botMembers.size / members.size * 100).toFixed(1) + '%',
            online: online.size,
            botList: botMembers.map(m => {
                const isAdmin = m.permissions.has(PermissionsBitField.Flags.Administrator);
                return {
                    tag: m.user.tag,
                    id: m.id,
                    admin: isAdmin,
                };
            }).sort((a, b) => a.tag.localeCompare(b.tag)),
        };
        jsonResult.memberStats = stats;

        console.log(`  Total Members: ${stats.total}`);
        console.log(`  Humans: ${stats.humans}`);
        console.log(`  Bots: ${stats.bots} (${stats.botRatio})`);
        console.log(`  Online: ${stats.online}`);
        console.log(`\n  Bot List:`);
        for (const bot of stats.botList) {
            const flag = bot.admin ? ' [ADMIN]' : '';
            console.log(`    - ${bot.tag} (${bot.id})${flag}`);
        }
    } catch (err) {
        console.error('  Section 2 error:', err.message);
    }

    // ========================================================================
    // SECTION 3: 3rd Party Bot Analysis
    // ========================================================================
    try {
        divider('SECTION 3: 3rd Party Bot Analysis');
        const botMembers = guild.members.cache.filter(m => m.user.bot);
        const botAnalysis = [];

        for (const [, member] of botMembers) {
            const roles = member.roles.cache.filter(r => r.id !== guild.id);
            const dangerousPermsList = DANGEROUS_PERMS.filter(p =>
                member.permissions.has(PermissionsBitField.Flags[p])
            );
            const managedRoles = guild.roles.cache.filter(r => r.managed && r.tags?.botId === member.id);
            const isReplace = REPLACE_BOTS.has(member.id);

            const entry = {
                tag: member.user.tag,
                id: member.id,
                replace: isReplace,
                roles: roles.map(r => ({ name: r.name, id: r.id })),
                dangerousPerms: dangerousPermsList,
                managedRoles: managedRoles.map(r => ({ name: r.name, id: r.id })),
            };
            botAnalysis.push(entry);

            const replaceFlag = isReplace ? ' [REPLACE]' : '';
            console.log(`\n  ${member.user.tag} (${member.id})${replaceFlag}`);
            console.log(`    Roles: ${roles.map(r => r.name).join(', ') || 'None'}`);
            if (dangerousPermsList.length) {
                console.log(`    Dangerous Perms: ${dangerousPermsList.join(', ')}`);
            }
            if (managedRoles.size) {
                console.log(`    Managed Roles: ${managedRoles.map(r => r.name).join(', ')}`);
            }
        }

        // Check our bot specifically
        const ourBot = guild.members.cache.get(BOT_ID);
        if (ourBot) {
            console.log(`\n  --- Our Bot (${BOT_ID}) ---`);
            console.log(`    Permissions: ${ourBot.permissions.toArray().join(', ')}`);
            console.log(`    Highest Role Position: ${ourBot.roles.highest.position} (${ourBot.roles.highest.name})`);
        } else {
            console.log(`\n  WARNING: Our bot (${BOT_ID}) is NOT in the server!`);
        }

        jsonResult.bots = botAnalysis;
    } catch (err) {
        console.error('  Section 3 error:', err.message);
    }

    // ========================================================================
    // SECTION 4: Role Hierarchy
    // ========================================================================
    try {
        divider('SECTION 4: Role Hierarchy');
        const roles = guild.roles.cache.sort((a, b) => b.position - a.position);
        const roleData = [];

        for (const [, role] of roles) {
            const flags = [];
            const nameLower = role.name.toLowerCase();
            if (role.permissions.has(PermissionsBitField.Flags.Administrator)) flags.push('ADMIN');
            if (role.permissions.has(PermissionsBitField.Flags.KickMembers) || role.permissions.has(PermissionsBitField.Flags.BanMembers)) flags.push('MOD');
            if (nameLower.includes('live') || nameLower.includes('stream')) flags.push('LIVE/STREAM');

            const entry = {
                position: role.position,
                name: role.name,
                id: role.id,
                color: role.hexColor,
                members: role.members.size,
                managed: role.managed,
                hoisted: role.hoist,
                flags,
            };
            roleData.push(entry);

            const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
            const managedStr = role.managed ? ' (managed)' : '';
            const hoistStr = role.hoist ? ' (hoisted)' : '';
            console.log(`  ${role.position.toString().padStart(3)}. ${role.name} (${role.id}) ${role.hexColor} | ${role.members.size} members${managedStr}${hoistStr}${flagStr}`);
        }

        jsonResult.roles = roleData;
    } catch (err) {
        console.error('  Section 4 error:', err.message);
    }

    // ========================================================================
    // SECTION 5: Channel Structure
    // ========================================================================
    try {
        divider('SECTION 5: Channel Structure');
        const channels = guild.channels.cache;
        const categories = channels.filter(c => c.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position);
        const uncategorized = channels.filter(c => !c.parentId && c.type !== ChannelType.GuildCategory).sort((a, b) => a.position - b.position);
        const channelData = [];

        const typeMap = {
            [ChannelType.GuildText]: 'text',
            [ChannelType.GuildVoice]: 'voice',
            [ChannelType.GuildAnnouncement]: 'announcement',
            [ChannelType.GuildStageVoice]: 'stage',
            [ChannelType.GuildForum]: 'forum',
            [ChannelType.GuildMedia]: 'media',
            [ChannelType.GuildCategory]: 'category',
        };

        function logChannel(ch, indent = '    ') {
            const highlight = ch.parentId === SOCIAL_LIVE_CATEGORY ? ' *** SOCIAL/LIVE ***' : '';
            const nsfw = ch.nsfw ? ' [NSFW]' : '';
            const slowmode = ch.rateLimitPerUser ? ` [slowmode: ${ch.rateLimitPerUser}s]` : '';
            const topic = ch.topic ? ` | Topic: ${ch.topic.substring(0, 60)}` : '';
            const type = typeMap[ch.type] || ch.type;
            console.log(`${indent}#${ch.name} (${ch.id}) [${type}]${nsfw}${slowmode}${topic}${highlight}`);
            return {
                name: ch.name,
                id: ch.id,
                type,
                nsfw: ch.nsfw || false,
                slowmode: ch.rateLimitPerUser || 0,
                topic: ch.topic || null,
                parentId: ch.parentId,
                socialLiveCategory: ch.parentId === SOCIAL_LIVE_CATEGORY,
            };
        }

        if (uncategorized.size) {
            console.log('  [No Category]');
            for (const [, ch] of uncategorized) {
                channelData.push(logChannel(ch));
            }
        }

        for (const [, cat] of categories) {
            const highlight = cat.id === SOCIAL_LIVE_CATEGORY ? ' *** SOCIAL/LIVE CATEGORY ***' : '';
            console.log(`\n  ${cat.name} (${cat.id})${highlight}`);
            channelData.push({ name: cat.name, id: cat.id, type: 'category', socialLiveCategory: cat.id === SOCIAL_LIVE_CATEGORY });

            const children = channels.filter(c => c.parentId === cat.id).sort((a, b) => a.position - b.position);
            for (const [, ch] of children) {
                channelData.push(logChannel(ch));
            }
        }

        jsonResult.channels = channelData;
    } catch (err) {
        console.error('  Section 5 error:', err.message);
    }

    // ========================================================================
    // SECTION 6: Active Threads
    // ========================================================================
    try {
        divider('SECTION 6: Active Threads');
        const threads = await guild.channels.fetchActiveThreads();
        const threadData = [];

        if (threads.threads.size === 0) {
            console.log('  No active threads.');
        } else {
            for (const [, thread] of threads.threads) {
                const entry = {
                    name: thread.name,
                    id: thread.id,
                    parentChannel: thread.parent?.name || 'unknown',
                    parentId: thread.parentId,
                    archived: thread.archived,
                    locked: thread.locked,
                };
                threadData.push(entry);
                console.log(`  #${thread.name} (${thread.id}) in #${entry.parentChannel} | archived: ${thread.archived} | locked: ${thread.locked}`);
            }
        }

        jsonResult.threads = threadData;
    } catch (err) {
        console.error('  Section 6 error:', err.message);
    }

    // ========================================================================
    // SECTION 7: Webhook Analysis
    // ========================================================================
    try {
        divider('SECTION 7: Webhook Analysis');
        const webhookData = [];
        const textChannels = guild.channels.cache.filter(c =>
            c.type === ChannelType.GuildText ||
            c.type === ChannelType.GuildAnnouncement ||
            c.type === ChannelType.GuildForum
        );

        for (const [, channel] of textChannels) {
            try {
                const webhooks = await channel.fetchWebhooks();
                for (const [, wh] of webhooks) {
                    const entry = {
                        name: wh.name,
                        id: wh.id,
                        creator: wh.owner ? `${wh.owner.tag} (${wh.owner.id})` : 'Unknown',
                        channel: `#${channel.name} (${channel.id})`,
                        avatarUrl: wh.avatarURL(),
                    };
                    webhookData.push(entry);
                    console.log(`  ${wh.name} | Creator: ${entry.creator} | Channel: ${entry.channel}`);
                }
            } catch {
                // May lack permission in some channels
            }
        }

        if (!webhookData.length) {
            console.log('  No webhooks found (or lacking permission).');
        }

        jsonResult.webhooks = webhookData;
    } catch (err) {
        console.error('  Section 7 error:', err.message);
    }

    // ========================================================================
    // SECTION 8: Discord AutoMod
    // ========================================================================
    try {
        divider('SECTION 8: Discord AutoMod');
        const rules = await guild.autoModerationRules.fetch();
        const automodData = [];

        if (rules.size === 0) {
            console.log('  No AutoMod rules configured.');
        } else {
            for (const [, rule] of rules) {
                const entry = {
                    name: rule.name,
                    id: rule.id,
                    enabled: rule.enabled,
                    triggerType: rule.triggerType,
                    actions: rule.actions.map(a => ({ type: a.type, metadata: a.metadata })),
                    creatorId: rule.creatorId,
                };
                automodData.push(entry);
                console.log(`  ${rule.name} (${rule.id})`);
                console.log(`    Enabled: ${rule.enabled}`);
                console.log(`    Trigger Type: ${rule.triggerType}`);
                console.log(`    Actions: ${rule.actions.map(a => `type=${a.type}`).join(', ')}`);
                console.log(`    Creator: ${rule.creatorId}`);
            }
        }

        jsonResult.automod = automodData;
    } catch (err) {
        console.error('  Section 8 error:', err.message);
    }

    // ========================================================================
    // SECTION 9: Permission Analysis
    // ========================================================================
    try {
        divider('SECTION 9: Permission Analysis');
        const permData = { issues: [], botAccess: [] };
        const textChannels = guild.channels.cache.filter(c =>
            c.type === ChannelType.GuildText ||
            c.type === ChannelType.GuildAnnouncement
        );
        const ourBot = guild.members.cache.get(BOT_ID);

        for (const [, channel] of textChannels) {
            // Check overwrites for staff-visibility issues
            const overwrites = channel.permissionOverwrites.cache;
            for (const [, ow] of overwrites) {
                if (ow.type === 0) { // role
                    const role = guild.roles.cache.get(ow.id);
                    if (role && ow.allow.has(PermissionsBitField.Flags.Administrator)) {
                        const issue = `#${channel.name}: Role "${role.name}" granted Administrator via overwrite`;
                        permData.issues.push(issue);
                        console.log(`  WARNING: ${issue}`);
                    }
                }
            }

            // Check our bot's access in social/live category channels
            if (channel.parentId === SOCIAL_LIVE_CATEGORY && ourBot) {
                const perms = channel.permissionsFor(ourBot);
                const entry = {
                    channel: `#${channel.name} (${channel.id})`,
                    sendMessages: perms.has(PermissionsBitField.Flags.SendMessages),
                    mentionEveryone: perms.has(PermissionsBitField.Flags.MentionEveryone),
                    embedLinks: perms.has(PermissionsBitField.Flags.EmbedLinks),
                    manageMessages: perms.has(PermissionsBitField.Flags.ManageMessages),
                    viewChannel: perms.has(PermissionsBitField.Flags.ViewChannel),
                };
                permData.botAccess.push(entry);
                const flags = [];
                if (!entry.sendMessages) flags.push('NO SEND');
                if (!entry.viewChannel) flags.push('NO VIEW');
                if (!entry.embedLinks) flags.push('NO EMBEDS');
                const status = flags.length ? flags.join(', ') : 'OK';
                console.log(`  Bot in #${channel.name}: ${status}`);
            }
        }

        if (!permData.issues.length) {
            console.log('  No admin-via-overwrite issues found.');
        }

        jsonResult.permissions = permData;
    } catch (err) {
        console.error('  Section 9 error:', err.message);
    }

    // ========================================================================
    // SECTION 10: Mee6/Lurker.tv Deep Scan (CRITICAL)
    // ========================================================================
    try {
        divider('SECTION 10: Mee6/Lurker.tv Deep Scan (CRITICAL)');
        console.log('  Scanning all channels in Social/Live category...');

        const socialChannels = guild.channels.cache.filter(c =>
            c.parentId === SOCIAL_LIVE_CATEGORY &&
            (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        );

        const streamerMap = new Map(); // key: "platform:username" → { platform, username, sourceBot, count, isStabCrazy }
        const botMessageCounts = {}; // botId → count
        let totalMessages = 0;

        for (const [, channel] of socialChannels) {
            console.log(`\n  Scanning #${channel.name} (${channel.id})...`);
            let lastId = null;
            let channelTotal = 0;

            while (true) {
                try {
                    const options = { limit: 100 };
                    if (lastId) options.before = lastId;

                    const messages = await channel.messages.fetch(options);
                    if (messages.size === 0) break;

                    for (const [, msg] of messages) {
                        totalMessages++;
                        channelTotal++;

                        // Track bot messages
                        if (msg.author.bot) {
                            botMessageCounts[msg.author.id] = (botMessageCounts[msg.author.id] || 0) + 1;
                        }

                        // Extract URLs from content
                        const allUrls = new Set();
                        const contentUrls = extractUrls(msg.content);
                        contentUrls.forEach(u => allUrls.add(u));

                        // Extract URLs from embeds
                        for (const embed of msg.embeds) {
                            if (embed.url) allUrls.add(embed.url);
                            extractUrls(embed.description).forEach(u => allUrls.add(u));
                            if (embed.author?.url) allUrls.add(embed.author.url);
                            if (embed.fields) {
                                for (const field of embed.fields) {
                                    extractUrls(field.name).forEach(u => allUrls.add(u));
                                    extractUrls(field.value).forEach(u => allUrls.add(u));
                                }
                            }
                        }

                        // Parse URLs and build streamer map
                        for (const url of allUrls) {
                            const parsed = parseStreamUrl(url);
                            if (!parsed) continue;

                            const key = `${parsed.platform}:${parsed.username}`;
                            const isStabCrazy = msg.author.id === STABCRAZY_ID;
                            const sourceBot = msg.author.bot ? msg.author.tag : (isStabCrazy ? 'StabCrazy (owner)' : msg.author.tag);

                            if (streamerMap.has(key)) {
                                const existing = streamerMap.get(key);
                                existing.count++;
                                if (isStabCrazy) existing.isStabCrazy = true;
                                if (!existing.sourceBots.includes(sourceBot)) existing.sourceBots.push(sourceBot);
                            } else {
                                // Also check if username matches stabcrazy in embed text
                                let stabFlag = isStabCrazy;
                                if (!stabFlag) {
                                    for (const embed of msg.embeds) {
                                        const embedText = [embed.title, embed.description, embed.author?.name].filter(Boolean).join(' ').toLowerCase();
                                        if (embedText.includes('stabcrazy')) {
                                            stabFlag = true;
                                            break;
                                        }
                                    }
                                }

                                streamerMap.set(key, {
                                    platform: parsed.platform,
                                    username: parsed.username,
                                    sourceBots: [sourceBot],
                                    count: 1,
                                    isStabCrazy: stabFlag,
                                });
                            }
                        }
                    }

                    lastId = messages.last().id;

                    // Rate limit delay
                    await sleep(1000);

                    if (messages.size < 100) break;
                } catch (fetchErr) {
                    console.error(`    Fetch error in #${channel.name}: ${fetchErr.message}`);
                    break;
                }
            }

            console.log(`    ${channelTotal} messages scanned in #${channel.name}`);
        }

        console.log(`\n  Total messages scanned: ${totalMessages}`);

        // Bot message counts
        console.log('\n  Bot Message Counts in Social/Live Category:');
        const sortedBotCounts = Object.entries(botMessageCounts).sort((a, b) => b[1] - a[1]);
        for (const [botId, count] of sortedBotCounts) {
            const member = guild.members.cache.get(botId);
            const tag = member ? member.user.tag : botId;
            const replaceFlag = REPLACE_BOTS.has(botId) ? ' [REPLACE]' : '';
            console.log(`    ${tag}: ${count} messages${replaceFlag}`);
        }

        // Streamer list
        const streamerList = Array.from(streamerMap.values()).map(s => ({
            platform: s.platform,
            username: s.username,
            sourceBot: s.sourceBots.join(', '),
            count: s.count,
            isStabCrazy: s.isStabCrazy,
        }));
        streamerList.sort((a, b) => b.count - a.count);

        console.log(`\n  Unique Streamers Found: ${streamerList.length}`);
        for (const s of streamerList) {
            const stabFlag = s.isStabCrazy ? ' [STABCRAZY]' : '';
            console.log(`    ${s.platform}/${s.username} (${s.count} mentions) via ${s.sourceBot}${stabFlag}`);
        }

        jsonResult.streamerList = streamerList;
        jsonResult.socialLiveBotCounts = botMessageCounts;
        jsonResult.socialLiveTotalMessages = totalMessages;
    } catch (err) {
        console.error('  Section 10 error:', err.message);
    }

    // ========================================================================
    // SECTION 11: CertiFried DB Config
    // ========================================================================
    try {
        divider('SECTION 11: CertiFried DB Config');
        const dbConfig = {};

        const tables = [
            { name: 'guilds', query: 'SELECT * FROM guilds WHERE guild_id = ?' },
            { name: 'logging_config', query: 'SELECT guild_id, log_channel_id, enabled_events, enabled FROM logging_config WHERE guild_id = ?' },
            { name: 'log_event_config', query: 'SELECT * FROM log_event_config WHERE guild_id = ?' },
            { name: 'welcome_settings', query: 'SELECT * FROM welcome_settings WHERE guild_id = ?' },
            { name: 'level_config', query: 'SELECT * FROM level_config WHERE guild_id = ?' },
            { name: 'ticket_panels', query: 'SELECT * FROM ticket_panels WHERE guild_id = ?' },
            { name: 'reaction_role_panels', query: 'SELECT * FROM reaction_role_panels WHERE guild_id = ?' },
            { name: 'reaction_roles', query: 'SELECT * FROM reaction_roles WHERE guild_id = ?' },
            { name: 'subscriptions_streamers', query: `SELECT s.*, st.platform, st.username FROM subscriptions s JOIN streamers st ON s.streamer_id = st.streamer_id WHERE s.guild_id = ?` },
            { name: 'guild_streamer_auto_track', query: 'SELECT * FROM guild_streamer_auto_track WHERE guild_id = ?' },
            { name: 'anti_nuke_config', query: 'SELECT * FROM anti_nuke_config WHERE guild_id = ?' },
            { name: 'raid_detection_config', query: 'SELECT * FROM raid_detection_config WHERE guild_id = ?' },
            { name: 'automod_config', query: 'SELECT * FROM automod_config WHERE guild_id = ?' },
            { name: 'phishing_config', query: 'SELECT * FROM phishing_config WHERE guild_id = ?' },
            { name: 'infractions', query: 'SELECT type, COUNT(*) as count FROM infractions WHERE guild_id = ? GROUP BY type' },
        ];

        for (const table of tables) {
            try {
                const [rows] = await pool.execute(table.query, [GUILD_ID]);
                dbConfig[table.name] = rows;
                if (rows.length) {
                    console.log(`  ${table.name}: ${rows.length} row(s)`);
                    if (rows.length <= 5) {
                        for (const row of rows) {
                            console.log(`    ${JSON.stringify(row)}`);
                        }
                    }
                } else {
                    console.log(`  ${table.name}: NOT CONFIGURED`);
                }
            } catch (tableErr) {
                console.log(`  ${table.name}: ERROR - ${tableErr.message}`);
                dbConfig[table.name] = { error: tableErr.message };
            }
        }

        jsonResult.dbConfig = dbConfig;
    } catch (err) {
        console.error('  Section 11 error:', err.message);
    }

    // ========================================================================
    // SECTION 12: Bot Activity Heatmap
    // ========================================================================
    try {
        divider('SECTION 12: Bot Activity Heatmap');
        const botActivity = {};
        const textChannels = guild.channels.cache.filter(c =>
            c.type === ChannelType.GuildText ||
            c.type === ChannelType.GuildAnnouncement
        );

        for (const [, channel] of textChannels) {
            try {
                const messages = await channel.messages.fetch({ limit: 100 });
                const channelBots = {};
                const embedTypes = {};
                const componentTypes = {};

                for (const [, msg] of messages) {
                    if (msg.author.bot) {
                        const botTag = msg.author.tag;
                        channelBots[botTag] = (channelBots[botTag] || 0) + 1;

                        for (const embed of msg.embeds) {
                            const type = embed.data?.type || 'rich';
                            embedTypes[type] = (embedTypes[type] || 0) + 1;
                        }

                        for (const row of msg.components) {
                            for (const comp of row.components) {
                                const cType = comp.type === 2 ? 'button' : comp.type === 3 ? 'select' : `type_${comp.type}`;
                                componentTypes[cType] = (componentTypes[cType] || 0) + 1;
                            }
                        }
                    }
                }

                if (Object.keys(channelBots).length) {
                    botActivity[`#${channel.name}`] = { bots: channelBots, embedTypes, componentTypes };
                    const topBot = Object.entries(channelBots).sort((a, b) => b[1] - a[1])[0];
                    console.log(`  #${channel.name}: ${Object.keys(channelBots).length} bots active, top: ${topBot[0]} (${topBot[1]} msgs)`);
                }
            } catch {
                // May lack access
            }
        }

        jsonResult.botActivity = botActivity;
    } catch (err) {
        console.error('  Section 12 error:', err.message);
    }

    // ========================================================================
    // SECTION 13: Logging Channel Detection
    // ========================================================================
    try {
        divider('SECTION 13: Logging Channel Detection');
        const logChannels = [];
        const textChannels = guild.channels.cache.filter(c =>
            (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
            c.name.toLowerCase().includes('log')
        );

        console.log(`  Channels with "log" in name: ${textChannels.size}`);

        for (const [, channel] of textChannels) {
            const entry = {
                name: channel.name,
                id: channel.id,
                parentCategory: channel.parent?.name || 'None',
                mee6Messages: 0,
            };

            try {
                const messages = await channel.messages.fetch({ limit: 100 });
                const mee6Msgs = messages.filter(m => m.author.id === MEE6_ID);
                entry.mee6Messages = mee6Msgs.size;
            } catch {
                entry.mee6Messages = -1; // No access
            }

            logChannels.push(entry);
            console.log(`  #${channel.name} (${channel.id}) in ${entry.parentCategory} | MEE6 msgs (last 100): ${entry.mee6Messages}`);
        }

        // Cross-reference with DB
        try {
            const [logConfig] = await pool.execute('SELECT * FROM logging_config WHERE guild_id = ?', [GUILD_ID]);
            if (logConfig.length) {
                console.log(`\n  DB logging_config: channel=${logConfig[0].log_channel_id}, enabled=${logConfig[0].enabled}`);
                const configChannel = guild.channels.cache.get(logConfig[0].log_channel_id);
                if (configChannel) {
                    console.log(`    Configured log channel: #${configChannel.name}`);
                } else {
                    console.log(`    WARNING: Configured log channel does not exist!`);
                }
            } else {
                console.log('\n  DB logging_config: NOT CONFIGURED');
            }
        } catch (dbErr) {
            console.log(`\n  DB logging_config check error: ${dbErr.message}`);
        }

        jsonResult.logChannels = logChannels;
    } catch (err) {
        console.error('  Section 13 error:', err.message);
    }

    // ========================================================================
    // SECTION 14: Recommendations
    // ========================================================================
    try {
        divider('SECTION 14: Recommendations');
        const recommendations = [];

        // Security issues
        const adminBots = jsonResult.bots?.filter(b => b.dangerousPerms?.includes('Administrator')) || [];
        if (adminBots.length) {
            const rec = `SECURITY: ${adminBots.length} bots have Administrator permission: ${adminBots.map(b => b.tag).join(', ')}`;
            recommendations.push(rec);
            console.log(`  ${rec}`);
        }

        // Permission problems
        const permIssues = jsonResult.permissions?.issues || [];
        if (permIssues.length) {
            for (const issue of permIssues) {
                recommendations.push(`PERMISSION: ${issue}`);
                console.log(`  PERMISSION: ${issue}`);
            }
        }

        // Bot access in social/live
        const noAccess = (jsonResult.permissions?.botAccess || []).filter(b => !b.sendMessages || !b.viewChannel);
        if (noAccess.length) {
            for (const ch of noAccess) {
                const rec = `BOT ACCESS: Missing permissions in ${ch.channel}`;
                recommendations.push(rec);
                console.log(`  ${rec}`);
            }
        }

        // Bot replacement plan
        console.log('\n  Bot Replacement Plan:');
        const replaceBots = [
            { id: MEE6_ID, name: 'MEE6', replaceWith: 'CertiFried leveling, moderation, logging' },
            { id: TICKETS_BOT_ID, name: 'Tickets Bot', replaceWith: 'CertiFried ticket system' },
            { id: UZOX_ID, name: 'Uzox', replaceWith: 'CertiFried utility commands' },
            { id: LURKER_TV_ID, name: 'Lurker.tv', replaceWith: 'CertiFried stream manager' },
        ];

        for (const bot of replaceBots) {
            const member = guild.members.cache.get(bot.id);
            const status = member ? 'IN SERVER' : 'NOT IN SERVER';
            const rec = `REPLACE ${bot.name} (${status}) -> ${bot.replaceWith}`;
            recommendations.push(rec);
            console.log(`    ${rec}`);
        }

        // Missing CertiFried configs
        console.log('\n  Missing CertiFried Configs:');
        const dbConfig = jsonResult.dbConfig || {};
        const importantTables = ['logging_config', 'welcome_settings', 'level_config', 'ticket_panels', 'anti_nuke_config', 'phishing_config'];
        for (const table of importantTables) {
            const data = dbConfig[table];
            if (!data || (Array.isArray(data) && data.length === 0)) {
                const rec = `MISSING CONFIG: ${table} not configured for this guild`;
                recommendations.push(rec);
                console.log(`    ${rec}`);
            }
        }

        // Streamer migration
        const streamerCount = jsonResult.streamerList?.length || 0;
        if (streamerCount) {
            const rec = `STREAMER MIGRATION: ${streamerCount} unique streamers found in social/live channels - import into CertiFried stream manager`;
            recommendations.push(rec);
            console.log(`\n  ${rec}`);

            const stabCrazyStreamers = jsonResult.streamerList.filter(s => s.isStabCrazy);
            if (stabCrazyStreamers.length) {
                const rec2 = `OWNER STREAMS: ${stabCrazyStreamers.length} StabCrazy streams detected - prioritize these`;
                recommendations.push(rec2);
                console.log(`  ${rec2}`);
            }
        }

        jsonResult.recommendations = recommendations;
    } catch (err) {
        console.error('  Section 14 error:', err.message);
    }

    // ========================================================================
    // Save JSON output
    // ========================================================================
    divider('SAVING RESULTS');
    try {
        await writeFile('/home/death/CertiFriedUtility/scripts/stabcrazy-audit-result.json', JSON.stringify(jsonResult, null, 2));
        console.log('  Results saved to scripts/stabcrazy-audit-result.json');
    } catch (err) {
        console.error('  Failed to save JSON:', err.message);
    }

    console.log('\n' + '='.repeat(80));
    console.log('  Audit complete!');
    console.log('='.repeat(80));

    client.destroy();
    await pool.end();
    process.exit(0);
}

audit().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
