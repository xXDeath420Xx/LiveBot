/**
 * Set up proper staff hierarchy and permissions for Growmie server
 *
 * Staff Tiers:
 * 1. 👑 Garden Master - Full Admin
 * 2. 🛡️ Greenhouse Guard - Moderator
 * 3. 🌿 Garden Helper - Junior Moderator
 */

import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

// Color scheme
const COLORS = {
    admin: 0xFF6B6B,      // Coral Red
    mod: 0x5865F2,        // Discord Blurple
    juniorMod: 0x57F287,  // Green
    verified: 0x228B22,   // Forest Green
    ogGrowmie: 0xFFD700,  // Gold
    trader: 0x20B2AA,     // Light Sea Green
    specialty: 0x32CD32,  // Lime Green
    notification: 0x808080, // Gray
    unverified: 0x95A5A6,  // Light Gray
};

// Staff role definitions with permissions
const STAFF_ROLES = [
    {
        name: '👑 Garden Master',
        color: COLORS.admin,
        hoist: true,
        position: 100,
        permissions: [
            PermissionFlagsBits.Administrator
        ],
        description: 'Full server administrator'
    },
    {
        name: '🛡️ Greenhouse Guard',
        color: COLORS.mod,
        hoist: true,
        position: 95,
        permissions: [
            PermissionFlagsBits.KickMembers,
            PermissionFlagsBits.BanMembers,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.ManageThreads,
            PermissionFlagsBits.ManageNicknames,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.DeafenMembers,
            PermissionFlagsBits.MoveMembers,
            PermissionFlagsBits.ModerateMembers,
            PermissionFlagsBits.ViewAuditLog,
            PermissionFlagsBits.ViewGuildInsights,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.UseExternalEmojis,
            PermissionFlagsBits.MentionEveryone,
        ],
        description: 'Full moderator - can ban, kick, timeout, manage messages'
    },
    {
        name: '🌿 Garden Helper',
        color: COLORS.juniorMod,
        hoist: true,
        position: 90,
        permissions: [
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.ManageThreads,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.ModerateMembers,
            PermissionFlagsBits.ViewAuditLog,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.UseExternalEmojis,
        ],
        description: 'Junior moderator - can timeout, delete messages, manage threads'
    }
];

// Member role definitions
const MEMBER_ROLES = [
    {
        name: '🎖️ OG Growmie',
        color: COLORS.ogGrowmie,
        hoist: true,
        position: 50,
        description: 'Veteran member (Level 5+)'
    },
    {
        name: '🌱 Verified Growmie',
        color: COLORS.verified,
        hoist: true,
        position: 45,
        description: 'Verified community member'
    },
    {
        name: '🏪 Verified Trader',
        color: COLORS.trader,
        hoist: false,
        position: 40,
        description: 'Approved to trade in marketplace'
    },
    // Specialty roles (self-assignable)
    { name: '🏠 Indoor Grower', color: COLORS.specialty, hoist: false, position: 35 },
    { name: '☀️ Outdoor Grower', color: 0xDAA520, hoist: false, position: 34 },
    { name: '💧 Hydro Enthusiast', color: 0x00CED1, hoist: false, position: 33 },
    { name: '🌍 Soil Squad', color: 0x8B4513, hoist: false, position: 32 },
    { name: '🔬 Nutrient Nerd', color: 0x9370DB, hoist: false, position: 31 },
    { name: '💡 Light Expert', color: 0xFFD700, hoist: false, position: 30 },
    { name: '🌡️ Climate Controller', color: 0x87CEEB, hoist: false, position: 29 },
    { name: '📸 Grow Journalist', color: 0xFF69B4, hoist: false, position: 28 },
    // Notification roles
    { name: '📢 Announcements', color: COLORS.notification, hoist: false, position: 20 },
    { name: '🎉 Events', color: COLORS.notification, hoist: false, position: 19 },
    // Unverified
    { name: '🌰 New Seed', color: COLORS.unverified, hoist: false, position: 10, description: 'New unverified member' },
];

async function main() {
    console.log('🌱 Setting up Growmie staff hierarchy and permissions...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error('❌ Guild not found!');
            process.exit(1);
        }

        const createdRoles = {};

        // ============================================
        // STEP 1: Create/Update Staff Roles
        // ============================================
        console.log('👥 Setting up staff roles...');

        for (const roleData of STAFF_ROLES) {
            let role = guild.roles.cache.find(r => r.name === roleData.name);

            if (role) {
                // Update existing role
                await role.edit({
                    color: roleData.color,
                    hoist: roleData.hoist,
                    permissions: roleData.permissions,
                    mentionable: true
                });
                console.log(`   ✏️  Updated: ${roleData.name}`);
            } else {
                // Create new role
                role = await guild.roles.create({
                    name: roleData.name,
                    color: roleData.color,
                    hoist: roleData.hoist,
                    permissions: roleData.permissions,
                    mentionable: true,
                    reason: 'Growmie staff setup'
                });
                console.log(`   ✅ Created: ${roleData.name}`);
            }
            createdRoles[roleData.name] = role;
        }

        // ============================================
        // STEP 2: Create/Update Member Roles
        // ============================================
        console.log('\n🎭 Setting up member roles...');

        for (const roleData of MEMBER_ROLES) {
            let role = guild.roles.cache.find(r => r.name === roleData.name);

            if (role) {
                await role.edit({
                    color: roleData.color,
                    hoist: roleData.hoist,
                });
                console.log(`   ✏️  Updated: ${roleData.name}`);
            } else {
                role = await guild.roles.create({
                    name: roleData.name,
                    color: roleData.color,
                    hoist: roleData.hoist,
                    permissions: [],
                    reason: 'Growmie member setup'
                });
                console.log(`   ✅ Created: ${roleData.name}`);
            }
            createdRoles[roleData.name] = role;
        }

        // Get role references
        const adminRole = createdRoles['👑 Garden Master'];
        const modRole = createdRoles['🛡️ Greenhouse Guard'];
        const juniorModRole = createdRoles['🌿 Garden Helper'];
        const verifiedRole = createdRoles['🌱 Verified Growmie'];
        const traderRole = createdRoles['🏪 Verified Trader'];
        const newSeedRole = createdRoles['🌰 New Seed'];
        const everyoneRole = guild.roles.everyone;

        // ============================================
        // STEP 3: Set up channel permissions
        // ============================================
        console.log('\n📁 Setting up channel permissions...');

        // Find key channels
        const rulesChannel = guild.channels.cache.find(c => c.name === '📜-rules');
        const announcementsChannel = guild.channels.cache.find(c => c.name.includes('announcements'));
        const introChannel = guild.channels.cache.find(c => c.name.includes('introductions'));
        const staffChatChannel = guild.channels.cache.find(c => c.name.includes('staff-chat'));
        const modLogsChannel = guild.channels.cache.find(c => c.name.includes('mod-logs'));
        const reportsChannel = guild.channels.cache.find(c => c.name.includes('reports'));

        // Set up RULES channel - visible to all, react allowed, no messages
        if (rulesChannel) {
            await rulesChannel.permissionOverwrites.set([
                {
                    id: everyoneRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions],
                    deny: [PermissionFlagsBits.SendMessages]
                },
                {
                    id: adminRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]
                }
            ]);
            console.log('   ✅ #📜-rules - Everyone can view & react');
        }

        // Set up ANNOUNCEMENTS - verified can view, only admin can post
        if (announcementsChannel) {
            await announcementsChannel.permissionOverwrites.set([
                {
                    id: everyoneRole.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: verifiedRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                    deny: [PermissionFlagsBits.SendMessages]
                },
                {
                    id: adminRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.MentionEveryone]
                },
                {
                    id: modRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                }
            ]);
            console.log('   ✅ #announcements - Verified view, staff post');
        }

        // Set up INTRODUCTIONS - verified can chat, new seeds can view
        if (introChannel) {
            await introChannel.permissionOverwrites.set([
                {
                    id: everyoneRole.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: newSeedRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                    deny: [PermissionFlagsBits.SendMessages]
                },
                {
                    id: verifiedRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions]
                }
            ]);
            console.log('   ✅ #introductions - Verified can chat');
        }

        // Set up STAFF channels - only staff can see
        const staffChannels = [staffChatChannel, modLogsChannel, reportsChannel].filter(c => c);
        for (const channel of staffChannels) {
            await channel.permissionOverwrites.set([
                {
                    id: everyoneRole.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: juniorModRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                },
                {
                    id: modRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
                },
                {
                    id: adminRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels]
                }
            ]);
            console.log(`   ✅ #${channel.name} - Staff only`);
        }

        // Set up MARKETPLACE channels - verified can view, traders can post
        const marketChannels = guild.channels.cache.filter(c =>
            c.name.includes('for-sale') ||
            c.name.includes('wanted') ||
            c.name.includes('trades') ||
            c.name.includes('feedback')
        );

        for (const [id, channel] of marketChannels) {
            await channel.permissionOverwrites.set([
                {
                    id: everyoneRole.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: verifiedRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                    deny: [PermissionFlagsBits.SendMessages]
                },
                {
                    id: traderRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks]
                },
                {
                    id: modRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]
                },
                {
                    id: adminRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]
                }
            ]);
            console.log(`   ✅ #${channel.name} - Traders can post, verified can view`);
        }

        // Marketplace rules - everyone in verified can view but not post
        const marketRulesChannel = guild.channels.cache.find(c => c.name.includes('marketplace-rules'));
        if (marketRulesChannel) {
            await marketRulesChannel.permissionOverwrites.set([
                {
                    id: everyoneRole.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: verifiedRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                    deny: [PermissionFlagsBits.SendMessages]
                },
                {
                    id: adminRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                }
            ]);
            console.log('   ✅ #marketplace-rules - Verified view only');
        }

        // Set up ALL OTHER channels - verified members only
        const regularChannels = guild.channels.cache.filter(c =>
            c.isTextBased() &&
            c.type !== ChannelType.GuildCategory &&
            !c.name.includes('rules') &&
            !c.name.includes('announcements') &&
            !c.name.includes('introductions') &&
            !c.name.includes('staff') &&
            !c.name.includes('mod-logs') &&
            !c.name.includes('reports') &&
            !c.name.includes('marketplace') &&
            !c.name.includes('for-sale') &&
            !c.name.includes('wanted') &&
            !c.name.includes('trades') &&
            !c.name.includes('feedback')
        );

        for (const [id, channel] of regularChannels) {
            try {
                await channel.permissionOverwrites.edit(everyoneRole, {
                    ViewChannel: false
                });
                await channel.permissionOverwrites.edit(verifiedRole, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                    AddReactions: true,
                    AttachFiles: true,
                    EmbedLinks: true
                });
            } catch (e) {}
        }
        console.log(`   ✅ ${regularChannels.size} regular channels - Verified members only`);

        // Set up VOICE channels
        const voiceChannels = guild.channels.cache.filter(c => c.isVoiceBased());
        for (const [id, channel] of voiceChannels) {
            try {
                await channel.permissionOverwrites.edit(everyoneRole, {
                    ViewChannel: false,
                    Connect: false
                });
                await channel.permissionOverwrites.edit(verifiedRole, {
                    ViewChannel: true,
                    Connect: true,
                    Speak: true,
                    Stream: true,
                    UseVAD: true
                });
                // Staff can move/mute in voice
                await channel.permissionOverwrites.edit(modRole, {
                    ViewChannel: true,
                    Connect: true,
                    MuteMembers: true,
                    DeafenMembers: true,
                    MoveMembers: true
                });
            } catch (e) {}
        }
        console.log(`   ✅ ${voiceChannels.size} voice channels - Verified can join, mods can moderate`);

        // ============================================
        // STEP 4: Reorder roles by position
        // ============================================
        console.log('\n📊 Reordering roles...');

        try {
            const rolePositions = [
                { role: adminRole, position: guild.roles.cache.size - 2 },
                { role: modRole, position: guild.roles.cache.size - 3 },
                { role: juniorModRole, position: guild.roles.cache.size - 4 },
            ];

            for (const { role, position } of rolePositions) {
                if (role && role.position < position) {
                    await role.setPosition(position).catch(() => {});
                }
            }
            console.log('   ✅ Staff roles positioned at top');
        } catch (e) {
            console.log('   ⚠️  Could not reorder some roles (may need manual adjustment)');
        }

        // ============================================
        // Summary
        // ============================================
        console.log('\n' + '═'.repeat(50));
        console.log('🎉 STAFF HIERARCHY SETUP COMPLETE');
        console.log('═'.repeat(50));
        console.log('\n📋 Staff Roles:');
        console.log('   👑 Garden Master (Admin)');
        console.log('      └ Full administrator access');
        console.log('   🛡️ Greenhouse Guard (Moderator)');
        console.log('      └ Ban, kick, timeout, manage messages, view audit log');
        console.log('   🌿 Garden Helper (Junior Mod)');
        console.log('      └ Timeout, delete messages, manage threads');
        console.log('\n📋 Member Roles:');
        console.log('   🎖️ OG Growmie - Veteran member (Level 5+)');
        console.log('   🌱 Verified Growmie - Verified community member');
        console.log('   🏪 Verified Trader - Can post in marketplace');
        console.log('   🌰 New Seed - Unverified new member');
        console.log('\n📋 Channel Access:');
        console.log('   📜 Rules - Everyone (view + react only)');
        console.log('   📢 Announcements - Verified (view), Staff (post)');
        console.log('   💬 Regular channels - Verified members only');
        console.log('   🏪 Marketplace - Verified (view), Traders (post)');
        console.log('   🔒 Staff channels - Staff only (tiered access)');
        console.log('   🔊 Voice - Verified can join, Mods can moderate');
        console.log('');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
