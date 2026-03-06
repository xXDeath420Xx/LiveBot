import { Client, GatewayIntentBits, ChannelType, PermissionsBitField } from 'discord.js';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

const GUILD_ID = process.argv[2] || '1307517872301670480';

// Database connection
let pool;
try {
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: 5
    });
} catch (e) {
    console.log('Database not available, skipping DB queries');
}

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
        GatewayIntentBits.GuildScheduledEvents
    ]
});

// Permission names for readability
const DANGEROUS_PERMISSIONS = [
    'Administrator',
    'ManageGuild',
    'ManageRoles',
    'ManageChannels',
    'KickMembers',
    'BanMembers',
    'ManageWebhooks',
    'ManageMessages',
    'MentionEveryone',
    'ViewAuditLog'
];

const PERMISSION_FLAGS = {
    Administrator: 0x8n,
    ManageGuild: 0x20n,
    ManageRoles: 0x10000000n,
    ManageChannels: 0x10n,
    KickMembers: 0x2n,
    BanMembers: 0x4n,
    ManageWebhooks: 0x20000000n,
    ManageMessages: 0x2000n,
    MentionEveryone: 0x20000n,
    ViewAuditLog: 0x80n
};

function hasPermission(permissionBitfield, permission) {
    const flag = PERMISSION_FLAGS[permission];
    if (!flag) return false;
    // Administrator has all permissions
    if (permissionBitfield & PERMISSION_FLAGS.Administrator) return true;
    return (permissionBitfield & flag) === flag;
}

function formatPermissions(permissions) {
    const perms = [];
    for (const perm of DANGEROUS_PERMISSIONS) {
        if (hasPermission(permissions.bitfield, perm)) {
            perms.push(perm);
        }
    }
    return perms;
}

async function getDbConfigs(guildId) {
    if (!pool) return {};

    const configs = {};

    try {
        // Anti-nuke config
        const [antiNuke] = await pool.execute(
            'SELECT * FROM anti_nuke_config WHERE guild_id = ?',
            [guildId]
        );
        configs.antiNuke = antiNuke[0] || null;

        // Raid detection
        const [raid] = await pool.execute(
            'SELECT * FROM raid_detection_config WHERE guild_id = ?',
            [guildId]
        );
        configs.raidDetection = raid[0] || null;

        // Selfbot detection
        const [selfbot] = await pool.execute(
            'SELECT * FROM selfbot_detection_config WHERE guild_id = ?',
            [guildId]
        );
        configs.selfbotDetection = selfbot[0] || null;

        // Logging config
        const [logging] = await pool.execute(
            'SELECT * FROM logging_config WHERE guild_id = ?',
            [guildId]
        );
        configs.logging = logging[0] || null;

        // Ticket panels
        const [panels] = await pool.execute(
            'SELECT * FROM ticket_panels WHERE guild_id = ?',
            [guildId]
        );
        configs.ticketPanels = panels;

        // Reaction roles
        const [reactionRoles] = await pool.execute(
            'SELECT * FROM reaction_roles WHERE guild_id = ?',
            [guildId]
        );
        configs.reactionRoles = reactionRoles;

        // Automod
        const [automod] = await pool.execute(
            'SELECT * FROM automod_config WHERE guild_id = ?',
            [guildId]
        );
        configs.automod = automod[0] || null;

        // Recent infractions
        const [infractions] = await pool.execute(
            'SELECT type, COUNT(*) as count FROM infractions WHERE guild_id = ? GROUP BY type',
            [guildId]
        );
        configs.infractionSummary = infractions;

    } catch (e) {
        console.log('Error fetching DB configs:', e.message);
    }

    return configs;
}

client.once('ready', async () => {
    console.log('='.repeat(80));
    console.log('CERTIFRIED UTILITY - SERVER AUDIT REPORT');
    console.log('='.repeat(80));
    console.log(`Generated: ${new Date().toISOString()}`);
    console.log(`Target Guild ID: ${GUILD_ID}`);
    console.log('='.repeat(80));

    const guild = client.guilds.cache.get(GUILD_ID);

    if (!guild) {
        console.log('\nERROR: Bot is not in the specified guild!');
        console.log('Available guilds:');
        client.guilds.cache.forEach(g => {
            console.log(`  - ${g.name} (${g.id})`);
        });
        process.exit(1);
    }

    // Fetch all data
    console.log('\nFetching server data...');

    try {
        await guild.members.fetch();
        await guild.channels.fetch();
        await guild.roles.fetch();
    } catch (e) {
        console.log('Warning: Could not fetch all data:', e.message);
    }

    const owner = await guild.fetchOwner().catch(() => null);

    // ============ BASIC INFO ============
    console.log('\n' + '='.repeat(80));
    console.log('1. SERVER OVERVIEW');
    console.log('='.repeat(80));
    console.log(`Server Name: ${guild.name}`);
    console.log(`Server ID: ${guild.id}`);
    console.log(`Owner: ${owner ? `${owner.user.tag} (${owner.id})` : 'Unknown'}`);
    console.log(`Created: ${guild.createdAt.toISOString()}`);
    console.log(`Verification Level: ${['None', 'Low', 'Medium', 'High', 'Very High'][guild.verificationLevel]}`);
    console.log(`Explicit Content Filter: ${['Disabled', 'Members without roles', 'All members'][guild.explicitContentFilter]}`);
    console.log(`2FA Required for Moderation: ${guild.mfaLevel === 1 ? 'Yes' : 'No'}`);
    console.log(`Boost Level: ${guild.premiumTier} (${guild.premiumSubscriptionCount || 0} boosts)`);
    console.log(`Vanity URL: ${guild.vanityURLCode || 'None'}`);

    // ============ MEMBER STATS ============
    console.log('\n' + '='.repeat(80));
    console.log('2. MEMBER STATISTICS');
    console.log('='.repeat(80));
    const members = guild.members.cache;
    const humans = members.filter(m => !m.user.bot);
    const bots = members.filter(m => m.user.bot);
    const online = members.filter(m => m.presence?.status && m.presence.status !== 'offline');

    console.log(`Total Members: ${guild.memberCount}`);
    console.log(`Humans: ${humans.size}`);
    console.log(`Bots: ${bots.size}`);
    console.log(`Bot Ratio: ${((bots.size / guild.memberCount) * 100).toFixed(1)}%`);
    console.log(`Online: ${online.size}`);

    if (bots.size > 0) {
        console.log('\nBots in Server:');
        bots.forEach(m => {
            const perms = formatPermissions(m.permissions);
            console.log(`  - ${m.user.tag} ${perms.includes('Administrator') ? '[ADMIN]' : ''}`);
        });
    }

    // ============ ROLES ============
    console.log('\n' + '='.repeat(80));
    console.log('3. ROLES HIERARCHY & PERMISSIONS');
    console.log('='.repeat(80));

    const roles = guild.roles.cache.sort((a, b) => b.position - a.position);
    console.log(`Total Roles: ${roles.size}`);

    const dangerousRoles = [];
    const adminRoles = [];
    const modRoles = [];

    roles.forEach(role => {
        const perms = formatPermissions(role.permissions);
        const memberCount = role.members.size;

        if (perms.includes('Administrator')) {
            adminRoles.push({ role, memberCount, perms });
        } else if (perms.length > 0) {
            modRoles.push({ role, memberCount, perms });
        }

        // Check for dangerous configurations
        if (role.permissions.has(PermissionsBitField.Flags.Administrator) &&
            !role.managed &&
            role.name !== '@everyone') {
            if (memberCount > 5) {
                dangerousRoles.push({
                    name: role.name,
                    issue: `Administrator role has ${memberCount} members - too many admins!`
                });
            }
        }
    });

    console.log('\nAdministrator Roles:');
    if (adminRoles.length === 0) {
        console.log('  None (WARNING: No admin roles!)');
    } else {
        adminRoles.forEach(({ role, memberCount }) => {
            console.log(`  - ${role.name} (${memberCount} members) [Position: ${role.position}]`);
        });
    }

    console.log('\nModerator Roles (with elevated permissions):');
    if (modRoles.length === 0) {
        console.log('  None');
    } else {
        modRoles.slice(0, 20).forEach(({ role, memberCount, perms }) => {
            console.log(`  - ${role.name} (${memberCount} members)`);
            console.log(`    Permissions: ${perms.join(', ')}`);
        });
        if (modRoles.length > 20) {
            console.log(`  ... and ${modRoles.length - 20} more roles with elevated permissions`);
        }
    }

    console.log('\nFull Role List:');
    roles.forEach(role => {
        const memberCount = role.members.size;
        const isManaged = role.managed ? ' [BOT/INTEGRATION]' : '';
        const isHoisted = role.hoist ? ' [HOISTED]' : '';
        const color = role.hexColor !== '#000000' ? ` ${role.hexColor}` : '';
        console.log(`  ${role.position.toString().padStart(2)}. ${role.name}${color} (${memberCount} members)${isManaged}${isHoisted}`);
    });

    // ============ CHANNELS ============
    console.log('\n' + '='.repeat(80));
    console.log('4. CHANNEL STRUCTURE');
    console.log('='.repeat(80));

    const channels = guild.channels.cache;
    const categories = channels.filter(c => c.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position);
    const textChannels = channels.filter(c => c.type === ChannelType.GuildText);
    const voiceChannels = channels.filter(c => c.type === ChannelType.GuildVoice);
    const stageChannels = channels.filter(c => c.type === ChannelType.GuildStageVoice);
    const forumChannels = channels.filter(c => c.type === ChannelType.GuildForum);
    const announcementChannels = channels.filter(c => c.type === ChannelType.GuildAnnouncement);

    console.log(`Total Channels: ${channels.size}`);
    console.log(`Categories: ${categories.size}`);
    console.log(`Text Channels: ${textChannels.size}`);
    console.log(`Voice Channels: ${voiceChannels.size}`);
    console.log(`Stage Channels: ${stageChannels.size}`);
    console.log(`Forum Channels: ${forumChannels.size}`);
    console.log(`Announcement Channels: ${announcementChannels.size}`);

    // Channel hierarchy
    console.log('\nChannel Hierarchy:');

    // Uncategorized channels first
    const uncategorized = channels.filter(c => !c.parentId && c.type !== ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);

    if (uncategorized.size > 0) {
        console.log('  [No Category]');
        uncategorized.forEach(channel => {
            const typeEmoji = getChannelTypeEmoji(channel.type);
            const nsfw = channel.nsfw ? ' [NSFW]' : '';
            console.log(`    ${typeEmoji} ${channel.name}${nsfw}`);
        });
    }

    categories.forEach(category => {
        const children = channels.filter(c => c.parentId === category.id)
            .sort((a, b) => a.position - b.position);
        console.log(`  [${category.name}] (${children.size} channels)`);
        children.forEach(channel => {
            const typeEmoji = getChannelTypeEmoji(channel.type);
            const nsfw = channel.nsfw ? ' [NSFW]' : '';
            const slowmode = channel.rateLimitPerUser > 0 ? ` [Slowmode: ${channel.rateLimitPerUser}s]` : '';
            console.log(`    ${typeEmoji} ${channel.name}${nsfw}${slowmode}`);
        });
    });

    // ============ PERMISSION OVERWRITES ============
    console.log('\n' + '='.repeat(80));
    console.log('5. CHANNEL PERMISSION OVERVIEW');
    console.log('='.repeat(80));

    const permIssues = [];

    textChannels.forEach(channel => {
        const overwrites = channel.permissionOverwrites.cache;
        const everyoneOverwrite = overwrites.get(guild.id);

        if (everyoneOverwrite) {
            // Check if @everyone can send messages in a staff channel
            if (channel.name.includes('staff') || channel.name.includes('admin') || channel.name.includes('mod')) {
                if (!everyoneOverwrite.deny.has(PermissionsBitField.Flags.ViewChannel)) {
                    permIssues.push({
                        channel: channel.name,
                        issue: 'Staff channel may be visible to @everyone'
                    });
                }
            }
        }

        // Check for unusual overwrites
        overwrites.forEach(overwrite => {
            if (overwrite.allow.has(PermissionsBitField.Flags.Administrator)) {
                const target = overwrite.type === 0 ? roles.get(overwrite.id)?.name : 'User';
                permIssues.push({
                    channel: channel.name,
                    issue: `Administrator permission granted to ${target} via channel overwrite`
                });
            }
        });
    });

    if (permIssues.length > 0) {
        console.log('\nPotential Permission Issues:');
        permIssues.forEach(({ channel, issue }) => {
            console.log(`  - #${channel}: ${issue}`);
        });
    } else {
        console.log('\nNo obvious permission issues detected.');
    }

    // ============ SECURITY FEATURES ============
    console.log('\n' + '='.repeat(80));
    console.log('6. SECURITY CONFIGURATION');
    console.log('='.repeat(80));

    console.log(`Verification Level: ${['None', 'Low', 'Medium', 'High', 'Very High'][guild.verificationLevel]}`);
    console.log(`2FA for Moderation: ${guild.mfaLevel === 1 ? 'Enabled' : 'Disabled'}`);
    console.log(`Explicit Content Filter: ${['Disabled', 'Members without roles', 'All members'][guild.explicitContentFilter]}`);

    // Get DB configs
    const dbConfigs = await getDbConfigs(GUILD_ID);

    console.log('\nCertiFried Protection Systems:');

    if (dbConfigs.antiNuke) {
        console.log(`  Anti-Nuke: ${dbConfigs.antiNuke.enabled ? 'ENABLED' : 'DISABLED'}`);
        if (dbConfigs.antiNuke.enabled) {
            console.log(`    - Max Channel Deletes: ${dbConfigs.antiNuke.max_channel_deletes || 3}`);
            console.log(`    - Max Role Deletes: ${dbConfigs.antiNuke.max_role_deletes || 3}`);
            console.log(`    - Max Bans: ${dbConfigs.antiNuke.max_bans || 3}`);
            console.log(`    - Action: ${dbConfigs.antiNuke.action || 'strip_roles'}`);
        }
    } else {
        console.log('  Anti-Nuke: NOT CONFIGURED');
    }

    if (dbConfigs.raidDetection) {
        console.log(`  Raid Detection: ${dbConfigs.raidDetection.enabled ? 'ENABLED' : 'DISABLED'}`);
        if (dbConfigs.raidDetection.enabled) {
            console.log(`    - Join Threshold: ${dbConfigs.raidDetection.join_threshold || 10}`);
            console.log(`    - Timeframe: ${dbConfigs.raidDetection.join_timeframe_seconds || 30}s`);
            console.log(`    - Action: ${dbConfigs.raidDetection.action || 'mute'}`);
        }
    } else {
        console.log('  Raid Detection: NOT CONFIGURED');
    }

    if (dbConfigs.selfbotDetection) {
        console.log(`  Selfbot Detection: ${dbConfigs.selfbotDetection.enabled ? 'ENABLED' : 'DISABLED'}`);
    } else {
        console.log('  Selfbot Detection: NOT CONFIGURED');
    }

    if (dbConfigs.logging) {
        console.log(`  Logging: CONFIGURED (Channel: ${dbConfigs.logging.log_channel_id || 'Not set'})`);
    } else {
        console.log('  Logging: NOT CONFIGURED');
    }

    if (dbConfigs.automod) {
        console.log(`  Automod: ${dbConfigs.automod.enabled ? 'ENABLED' : 'DISABLED'}`);
    } else {
        console.log('  Automod: NOT CONFIGURED');
    }

    // ============ INTEGRATIONS ============
    console.log('\n' + '='.repeat(80));
    console.log('7. INTEGRATIONS & FEATURES');
    console.log('='.repeat(80));

    if (dbConfigs.ticketPanels && dbConfigs.ticketPanels.length > 0) {
        console.log(`\nTicket Panels: ${dbConfigs.ticketPanels.length}`);
        dbConfigs.ticketPanels.forEach(panel => {
            console.log(`  - ${panel.panel_id}: ${panel.deployed ? 'Deployed' : 'Not deployed'}`);
        });
    } else {
        console.log('\nTicket Panels: None configured');
    }

    if (dbConfigs.reactionRoles && dbConfigs.reactionRoles.length > 0) {
        console.log(`\nReaction Roles: ${dbConfigs.reactionRoles.length} configured`);
    } else {
        console.log('\nReaction Roles: None configured');
    }

    // ============ EMOJIS & STICKERS ============
    console.log('\n' + '='.repeat(80));
    console.log('8. EMOJIS & STICKERS');
    console.log('='.repeat(80));

    const emojis = guild.emojis.cache;
    const staticEmojis = emojis.filter(e => !e.animated);
    const animatedEmojis = emojis.filter(e => e.animated);

    console.log(`Total Emojis: ${emojis.size}`);
    console.log(`Static: ${staticEmojis.size}`);
    console.log(`Animated: ${animatedEmojis.size}`);
    console.log(`Stickers: ${guild.stickers.cache.size}`);

    // Emoji limits based on boost level
    const emojiLimits = [50, 100, 150, 250];
    const limit = emojiLimits[guild.premiumTier] || 50;
    console.log(`Emoji Slots Used: ${staticEmojis.size}/${limit} static, ${animatedEmojis.size}/${limit} animated`);

    // ============ MODERATION HISTORY ============
    if (dbConfigs.infractionSummary && dbConfigs.infractionSummary.length > 0) {
        console.log('\n' + '='.repeat(80));
        console.log('9. MODERATION HISTORY SUMMARY');
        console.log('='.repeat(80));

        dbConfigs.infractionSummary.forEach(({ type, count }) => {
            console.log(`  ${type}: ${count}`);
        });
    }

    // ============ RECOMMENDATIONS ============
    console.log('\n' + '='.repeat(80));
    console.log('10. RECOMMENDATIONS & ISSUES');
    console.log('='.repeat(80));

    const recommendations = [];
    const issues = [];

    // Security checks
    if (guild.verificationLevel < 2) {
        issues.push('LOW: Verification level is below Medium - increases spam/raid risk');
        recommendations.push('Increase verification level to at least Medium');
    }

    if (guild.mfaLevel === 0) {
        issues.push('MEDIUM: 2FA is not required for moderator actions');
        recommendations.push('Enable 2FA requirement for moderator actions in Server Settings > Safety');
    }

    if (!dbConfigs.antiNuke || !dbConfigs.antiNuke.enabled) {
        issues.push('MEDIUM: Anti-nuke protection is not enabled');
        recommendations.push('Enable anti-nuke with /antinuke enable');
    }

    if (!dbConfigs.raidDetection || !dbConfigs.raidDetection.enabled) {
        issues.push('MEDIUM: Raid detection is not enabled');
        recommendations.push('Enable raid detection with /raid-protection enable');
    }

    if (!dbConfigs.logging) {
        issues.push('LOW: Logging is not configured');
        recommendations.push('Set up logging for moderation actions and security events');
    }

    // Role checks
    const adminCount = adminRoles.reduce((sum, r) => sum + r.memberCount, 0);
    if (adminCount > 10) {
        issues.push(`HIGH: ${adminCount} users have Administrator permission - this is excessive`);
        recommendations.push('Review and reduce the number of administrators');
    }

    if (bots.size > humans.size * 0.2) {
        issues.push('LOW: High bot-to-human ratio may indicate spam or abandoned bots');
        recommendations.push('Review and remove unused bots');
    }

    // Check for bot admin
    const adminBots = bots.filter(m => m.permissions.has(PermissionsBitField.Flags.Administrator));
    if (adminBots.size > 3) {
        issues.push(`MEDIUM: ${adminBots.size} bots have Administrator permission`);
        recommendations.push('Review bot permissions - most bots don\'t need full admin');
    }

    // Channel checks
    if (categories.size === 0 && textChannels.size > 10) {
        issues.push('LOW: No categories but many channels - organization could be improved');
        recommendations.push('Organize channels into categories for better navigation');
    }

    // Check dangerous roles
    dangerousRoles.forEach(({ name, issue }) => {
        issues.push(`HIGH: Role "${name}": ${issue}`);
    });

    // Add permission issues
    permIssues.forEach(({ channel, issue }) => {
        issues.push(`MEDIUM: #${channel}: ${issue}`);
    });

    if (issues.length > 0) {
        console.log('\nIssues Found:');
        issues.forEach((issue, i) => {
            console.log(`  ${i + 1}. ${issue}`);
        });
    } else {
        console.log('\nNo major issues found!');
    }

    if (recommendations.length > 0) {
        console.log('\nRecommendations:');
        recommendations.forEach((rec, i) => {
            console.log(`  ${i + 1}. ${rec}`);
        });
    }

    console.log('\n' + '='.repeat(80));
    console.log('END OF AUDIT REPORT');
    console.log('='.repeat(80));

    // Cleanup
    if (pool) await pool.end();
    client.destroy();
    process.exit(0);
});

function getChannelTypeEmoji(type) {
    const emojis = {
        [ChannelType.GuildText]: '#',
        [ChannelType.GuildVoice]: '🔊',
        [ChannelType.GuildCategory]: '📁',
        [ChannelType.GuildAnnouncement]: '📢',
        [ChannelType.GuildStageVoice]: '🎭',
        [ChannelType.GuildForum]: '💬',
        [ChannelType.GuildDirectory]: '📂',
        [ChannelType.PrivateThread]: '🧵',
        [ChannelType.PublicThread]: '🧵',
    };
    return emojis[type] || '?';
}

client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('Failed to login:', err.message);
    process.exit(1);
});
