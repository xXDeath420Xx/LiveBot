/**
 * Growmie Discord Server Setup Script
 * Sets up a complete growing/gardening community server
 *
 * Server ID: 1452972683867459657
 * Bot ID: 1452969400620683276
 */

import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

// Color scheme - earthy greens
const COLORS = {
    primary: 0x228B22,      // Forest Green
    secondary: 0x32CD32,    // Lime Green
    accent: 0x90EE90,       // Light Green
    gold: 0xDAA520,         // Goldenrod
    earth: 0x8B4513,        // Saddle Brown
    admin: 0xFF6B6B,        // Coral Red
    mod: 0x5865F2,          // Discord Blurple
};

// Role definitions
const ROLES = [
    // Staff roles
    { name: '👑 Garden Master', color: COLORS.admin, hoist: true, position: 100, permissions: [PermissionFlagsBits.Administrator] },
    { name: '🛡️ Greenhouse Guard', color: COLORS.mod, hoist: true, position: 90, permissions: [
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.MuteMembers,
        PermissionFlagsBits.ManageNicknames,
        PermissionFlagsBits.ViewAuditLog,
        PermissionFlagsBits.ModerateMembers
    ]},

    // Verified member role
    { name: '🌱 Verified Growmie', color: COLORS.primary, hoist: true, position: 50 },

    // Specialty roles (self-assignable via reaction roles)
    { name: '🏠 Indoor Grower', color: COLORS.secondary, hoist: false, position: 40 },
    { name: '☀️ Outdoor Grower', color: COLORS.gold, hoist: false, position: 39 },
    { name: '💧 Hydro Enthusiast', color: 0x00CED1, hoist: false, position: 38 },
    { name: '🌍 Soil Squad', color: COLORS.earth, hoist: false, position: 37 },
    { name: '🔬 Nutrient Nerd', color: 0x9370DB, hoist: false, position: 36 },
    { name: '💡 Light Expert', color: 0xFFD700, hoist: false, position: 35 },
    { name: '🌡️ Climate Controller', color: 0x87CEEB, hoist: false, position: 34 },
    { name: '📸 Grow Journalist', color: 0xFF69B4, hoist: false, position: 33 },

    // Activity roles
    { name: '🏪 Verified Trader', color: 0x20B2AA, hoist: false, position: 30 },
    { name: '🎖️ OG Growmie', color: 0xFFD700, hoist: true, position: 45 },

    // Notification roles
    { name: '📢 Announcements', color: 0x808080, hoist: false, position: 20 },
    { name: '🎉 Events', color: 0x808080, hoist: false, position: 19 },

    // Unverified role
    { name: '🌰 New Seed', color: 0x808080, hoist: false, position: 10 },
];

// Channel categories and channels
const CATEGORIES = [
    {
        name: '🚪 WELCOME CENTER',
        channels: [
            { name: '📜-rules', type: ChannelType.GuildText, topic: 'Community rules and guidelines - Read before participating!' },
            { name: '✅-verify', type: ChannelType.GuildText, topic: 'Verify your age to access the community' },
            { name: '📢-announcements', type: ChannelType.GuildText, topic: 'Important community announcements' },
            { name: '👋-introductions', type: ChannelType.GuildText, topic: 'Introduce yourself to the community!' },
        ]
    },
    {
        name: '💬 COMMUNITY',
        channels: [
            { name: '🌿-general', type: ChannelType.GuildText, topic: 'General chat for the Growmie community' },
            { name: '🎭-off-topic', type: ChannelType.GuildText, topic: 'Non-growing related discussions' },
            { name: '🤖-bot-commands', type: ChannelType.GuildText, topic: 'Use bot commands here' },
            { name: '🎨-memes-media', type: ChannelType.GuildText, topic: 'Share memes and media' },
        ]
    },
    {
        name: '🌱 GROWING DISCUSSION',
        channels: [
            { name: '🏠-indoor-growing', type: ChannelType.GuildText, topic: 'Indoor growing tips, setups, and discussions' },
            { name: '☀️-outdoor-growing', type: ChannelType.GuildText, topic: 'Outdoor and greenhouse growing discussions' },
            { name: '💧-hydroponics', type: ChannelType.GuildText, topic: 'Hydroponic, aeroponic, and DWC setups' },
            { name: '🌍-soil-organic', type: ChannelType.GuildText, topic: 'Soil growing, living soil, and organic methods' },
            { name: '❓-grow-help', type: ChannelType.GuildText, topic: 'Ask questions and get help with your grow' },
        ]
    },
    {
        name: '⚙️ EQUIPMENT & SETUP',
        channels: [
            { name: '💡-lighting', type: ChannelType.GuildText, topic: 'Grow lights - LED, HPS, CMH, and more' },
            { name: '🏕️-tents-rooms', type: ChannelType.GuildText, topic: 'Grow tents, rooms, and space setup' },
            { name: '🌡️-climate-control', type: ChannelType.GuildText, topic: 'Temperature, humidity, ventilation, and HVAC' },
            { name: '🔧-diy-builds', type: ChannelType.GuildText, topic: 'DIY projects and custom builds' },
            { name: '💰-deals-finds', type: ChannelType.GuildText, topic: 'Share deals and equipment finds' },
        ]
    },
    {
        name: '🧪 NUTRIENTS & FEEDING',
        channels: [
            { name: '🧪-nutrient-chat', type: ChannelType.GuildText, topic: 'Nutrient brands, schedules, and mixing' },
            { name: '🔬-deficiencies', type: ChannelType.GuildText, topic: 'Identify and fix plant deficiencies' },
            { name: '📊-feed-schedules', type: ChannelType.GuildText, topic: 'Share and discuss feeding schedules' },
            { name: '🦠-pest-disease', type: ChannelType.GuildText, topic: 'Pest prevention and disease management' },
        ]
    },
    {
        name: '📸 SHOW & TELL',
        channels: [
            { name: '📔-grow-journals', type: ChannelType.GuildForum, topic: 'Document your grows from seed to harvest' },
            { name: '🌿-plant-pics', type: ChannelType.GuildText, topic: 'Show off your plants!' },
            { name: '🎃-harvest-gallery', type: ChannelType.GuildText, topic: 'Share your harvests and yields' },
            { name: '🏆-setup-showcase', type: ChannelType.GuildText, topic: 'Show off your grow setup' },
        ]
    },
    {
        name: '🏪 MARKETPLACE',
        channels: [
            { name: '📋-marketplace-rules', type: ChannelType.GuildText, topic: 'Rules for trading and selling' },
            { name: '💸-for-sale', type: ChannelType.GuildText, topic: 'Items for sale' },
            { name: '🔍-wanted', type: ChannelType.GuildText, topic: 'Looking to buy' },
            { name: '🔄-trades', type: ChannelType.GuildText, topic: 'Trade offers and barter' },
            { name: '⭐-feedback', type: ChannelType.GuildText, topic: 'Trader feedback and vouches' },
        ]
    },
    {
        name: '🔊 VOICE CHANNELS',
        channels: [
            { name: '🌿 Growmie Lounge', type: ChannelType.GuildVoice },
            { name: '💬 Grow Talk', type: ChannelType.GuildVoice },
            { name: '🎮 Gaming', type: ChannelType.GuildVoice },
            { name: '🔇 AFK', type: ChannelType.GuildVoice },
        ]
    },
    {
        name: '🔒 STAFF',
        channels: [
            { name: '👥-staff-chat', type: ChannelType.GuildText, topic: 'Staff discussion' },
            { name: '📝-mod-logs', type: ChannelType.GuildText, topic: 'Moderation logs' },
            { name: '🚨-reports', type: ChannelType.GuildText, topic: 'User reports' },
        ]
    },
];

async function main() {
    console.log('🌱 Growmie Server Setup Script');
    console.log('================================\n');

    // Get bot token from database
    console.log('📡 Fetching bot credentials...');
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    if (bots.length === 0) {
        console.error('❌ Bot not found in database!');
        process.exit(1);
    }

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    // Create client
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
        ]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}`);

        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error('❌ Guild not found! Make sure the bot is in the server.');
            process.exit(1);
        }

        console.log(`📍 Setting up server: ${guild.name}\n`);

        try {
            // Step 1: Create Roles
            console.log('🎭 Creating roles...');
            const createdRoles = {};

            for (const roleData of ROLES) {
                const existingRole = guild.roles.cache.find(r => r.name === roleData.name);
                if (existingRole) {
                    console.log(`   ⏭️  Role "${roleData.name}" already exists`);
                    createdRoles[roleData.name] = existingRole;
                } else {
                    const role = await guild.roles.create({
                        name: roleData.name,
                        color: roleData.color,
                        hoist: roleData.hoist,
                        permissions: roleData.permissions || [],
                        reason: 'Growmie server setup'
                    });
                    console.log(`   ✅ Created role: ${roleData.name}`);
                    createdRoles[roleData.name] = role;
                }
            }

            // Step 2: Create Categories and Channels
            console.log('\n📁 Creating categories and channels...');

            const verifiedRole = createdRoles['🌱 Verified Growmie'];
            const newSeedRole = createdRoles['🌰 New Seed'];
            const staffRole = createdRoles['👑 Garden Master'];
            const modRole = createdRoles['🛡️ Greenhouse Guard'];
            const traderRole = createdRoles['🏪 Verified Trader'];

            for (const categoryData of CATEGORIES) {
                // Check if category exists
                let category = guild.channels.cache.find(
                    c => c.type === ChannelType.GuildCategory && c.name === categoryData.name
                );

                if (!category) {
                    // Set up permissions based on category
                    let permissionOverwrites = [];

                    if (categoryData.name === '🔒 STAFF') {
                        // Staff only
                        permissionOverwrites = [
                            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                            { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel] },
                            { id: modRole.id, allow: [PermissionFlagsBits.ViewChannel] },
                        ];
                    } else if (categoryData.name === '🚪 WELCOME CENTER') {
                        // Everyone can see welcome, but limited interaction
                        permissionOverwrites = [
                            { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                        ];
                    } else if (categoryData.name === '🏪 MARKETPLACE') {
                        // Verified + Trader access
                        permissionOverwrites = [
                            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                            { id: verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
                            { id: traderRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        ];
                    } else {
                        // Verified members only for most channels
                        permissionOverwrites = [
                            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                            { id: verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        ];
                    }

                    category = await guild.channels.create({
                        name: categoryData.name,
                        type: ChannelType.GuildCategory,
                        permissionOverwrites,
                        reason: 'Growmie server setup'
                    });
                    console.log(`   📁 Created category: ${categoryData.name}`);
                } else {
                    console.log(`   ⏭️  Category "${categoryData.name}" already exists`);
                }

                // Create channels in category
                for (const channelData of categoryData.channels) {
                    const existingChannel = guild.channels.cache.find(
                        c => c.name === channelData.name.replace(/^[^\w-]+/, '').toLowerCase().replace(/\s+/g, '-') ||
                             c.name === channelData.name
                    );

                    if (existingChannel) {
                        console.log(`      ⏭️  Channel "${channelData.name}" already exists`);
                        continue;
                    }

                    const channelOptions = {
                        name: channelData.name,
                        type: channelData.type,
                        parent: category.id,
                        reason: 'Growmie server setup'
                    };

                    if (channelData.topic) {
                        channelOptions.topic = channelData.topic;
                    }

                    // Special permissions for specific channels
                    if (channelData.name === '✅-verify') {
                        channelOptions.permissionOverwrites = [
                            { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                            { id: verifiedRole.id, deny: [PermissionFlagsBits.ViewChannel] },
                        ];
                    } else if (channelData.name === '👋-introductions') {
                        channelOptions.permissionOverwrites = [
                            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                            { id: verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                            { id: newSeedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        ];
                    } else if (channelData.name === '📢-announcements') {
                        channelOptions.permissionOverwrites = [
                            { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                            { id: staffRole.id, allow: [PermissionFlagsBits.SendMessages] },
                        ];
                    } else if (channelData.name === '📋-marketplace-rules') {
                        channelOptions.permissionOverwrites = [
                            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                            { id: verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                            { id: traderRole.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                            { id: staffRole.id, allow: [PermissionFlagsBits.SendMessages] },
                        ];
                    }

                    await guild.channels.create(channelOptions);
                    console.log(`      ✅ Created channel: ${channelData.name}`);
                }
            }

            // Step 3: Set up server settings
            console.log('\n⚙️  Configuring server settings...');

            await guild.setVerificationLevel(2); // Medium - must have verified email
            await guild.setExplicitContentFilter(2); // Scan all messages
            console.log('   ✅ Set verification level to Medium');
            console.log('   ✅ Enabled explicit content filter');

            // Step 4: Post rules in rules channel
            console.log('\n📜 Posting rules...');
            const rulesChannel = guild.channels.cache.find(c => c.name.includes('rules'));
            if (rulesChannel) {
                const rulesEmbed = new EmbedBuilder()
                    .setColor(COLORS.primary)
                    .setTitle('🌱 Growmie Community Rules')
                    .setDescription('Welcome to the Growmie community! Please read and follow these rules to keep our garden flourishing.')
                    .addFields(
                        {
                            name: '1️⃣ Age Requirement',
                            value: 'You must be **21 years or older** to participate in this community. This is strictly enforced.',
                            inline: false
                        },
                        {
                            name: '2️⃣ Respect Everyone',
                            value: 'Treat all members with respect. No harassment, hate speech, discrimination, or personal attacks.',
                            inline: false
                        },
                        {
                            name: '3️⃣ No Illegal Activity',
                            value: 'Do not discuss or promote illegal activities. Follow your local laws and regulations.',
                            inline: false
                        },
                        {
                            name: '4️⃣ Keep It Private',
                            value: 'Do not share personal information (yours or others). Protect your privacy and the privacy of fellow Growmies.',
                            inline: false
                        },
                        {
                            name: '5️⃣ No Spam or Self-Promotion',
                            value: 'No spamming, excessive self-promotion, or advertising without permission.',
                            inline: false
                        },
                        {
                            name: '6️⃣ Use Correct Channels',
                            value: 'Post content in the appropriate channels. Use bot commands in #bot-commands.',
                            inline: false
                        },
                        {
                            name: '7️⃣ Marketplace Rules',
                            value: 'Trading requires the Verified Trader role. No scamming - report suspicious activity immediately.',
                            inline: false
                        },
                        {
                            name: '8️⃣ NSFW Policy',
                            value: 'Keep content appropriate. No explicit content outside of properly marked channels.',
                            inline: false
                        },
                        {
                            name: '9️⃣ Listen to Staff',
                            value: 'Follow instructions from Garden Masters and Greenhouse Guards. Their decisions are final.',
                            inline: false
                        },
                        {
                            name: '🔟 Have Fun!',
                            value: 'This is a community for passionate growers. Share knowledge, help each other, and enjoy the journey!',
                            inline: false
                        }
                    )
                    .setFooter({ text: 'Breaking rules may result in warnings, mutes, or bans. | Last Updated' })
                    .setTimestamp();

                await rulesChannel.send({ embeds: [rulesEmbed] });
                console.log('   ✅ Posted rules');
            }

            // Step 5: Post verification message
            console.log('\n✅ Setting up verification...');
            const verifyChannel = guild.channels.cache.find(c => c.name.includes('verify'));
            if (verifyChannel) {
                const verifyEmbed = new EmbedBuilder()
                    .setColor(COLORS.primary)
                    .setTitle('🌱 Age Verification Required')
                    .setDescription(
                        'Welcome to the Growmie community!\n\n' +
                        '**This is an age-restricted community (21+)**\n\n' +
                        'To access the server, you must verify that you are 21 years or older.\n\n' +
                        '**How to verify:**\n' +
                        '1. React with ✅ below to confirm you are 21+\n' +
                        '2. A staff member will review and grant you access\n\n' +
                        '⚠️ **By verifying, you confirm that:**\n' +
                        '• You are at least 21 years old\n' +
                        '• You have read and agree to the server rules\n' +
                        '• You understand this is a private community'
                    )
                    .setFooter({ text: 'False verification will result in a permanent ban.' });

                const verifyMsg = await verifyChannel.send({ embeds: [verifyEmbed] });
                await verifyMsg.react('✅');
                console.log('   ✅ Posted verification message');
            }

            // Step 6: Create role selection message
            console.log('\n🎭 Setting up role selection...');
            const introChannel = guild.channels.cache.find(c => c.name.includes('introductions'));
            if (introChannel) {
                const roleEmbed = new EmbedBuilder()
                    .setColor(COLORS.secondary)
                    .setTitle('🎭 Choose Your Growing Style')
                    .setDescription(
                        'React to get roles that match your growing interests!\n\n' +
                        '🏠 - Indoor Grower\n' +
                        '☀️ - Outdoor Grower\n' +
                        '💧 - Hydro Enthusiast\n' +
                        '🌍 - Soil Squad\n' +
                        '🔬 - Nutrient Nerd\n' +
                        '💡 - Light Expert\n' +
                        '🌡️ - Climate Controller\n' +
                        '📸 - Grow Journalist\n\n' +
                        '**Notification Roles:**\n' +
                        '📢 - Announcements\n' +
                        '🎉 - Events'
                    )
                    .setFooter({ text: 'Click reactions to toggle roles' });

                const roleMsg = await introChannel.send({ embeds: [roleEmbed] });
                const reactions = ['🏠', '☀️', '💧', '🌍', '🔬', '💡', '🌡️', '📸', '📢', '🎉'];
                for (const emoji of reactions) {
                    await roleMsg.react(emoji);
                }
                console.log('   ✅ Posted role selection message');

                // Store reaction role config in database
                const roleMapping = {
                    '🏠': createdRoles['🏠 Indoor Grower']?.id,
                    '☀️': createdRoles['☀️ Outdoor Grower']?.id,
                    '💧': createdRoles['💧 Hydro Enthusiast']?.id,
                    '🌍': createdRoles['🌍 Soil Squad']?.id,
                    '🔬': createdRoles['🔬 Nutrient Nerd']?.id,
                    '💡': createdRoles['💡 Light Expert']?.id,
                    '🌡️': createdRoles['🌡️ Climate Controller']?.id,
                    '📸': createdRoles['📸 Grow Journalist']?.id,
                    '📢': createdRoles['📢 Announcements']?.id,
                    '🎉': createdRoles['🎉 Events']?.id,
                };

                // Save to reaction_role_panels
                await pool.execute(`
                    INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, title, roles, created_by)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE roles = VALUES(roles)
                `, [GUILD_ID, introChannel.id, roleMsg.id, 'Growing Style Roles', JSON.stringify(roleMapping), '0']);
                console.log('   ✅ Saved reaction role configuration');
            }

            // Step 7: Configure bot features in database
            console.log('\n🤖 Configuring bot features...');

            // Enable welcome messages
            const announcementsChannel = guild.channels.cache.find(c => c.name.includes('announcements'));
            if (announcementsChannel && verifiedRole) {
                await pool.execute(`
                    INSERT INTO guild_settings (guild_id, setting_key, setting_value)
                    VALUES
                        (?, 'welcome_enabled', '1'),
                        (?, 'welcome_channel', ?),
                        (?, 'welcome_message', ?),
                        (?, 'autorole_enabled', '1'),
                        (?, 'autorole_id', ?)
                    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
                `, [
                    GUILD_ID,
                    GUILD_ID, announcementsChannel.id,
                    GUILD_ID, 'Welcome to the garden, {user}! 🌱 Head to #introductions to introduce yourself and pick your roles!',
                    GUILD_ID,
                    GUILD_ID, newSeedRole.id
                ]);
                console.log('   ✅ Configured welcome messages');
                console.log('   ✅ Configured auto-role (New Seed)');
            }

            // Enable leveling
            await pool.execute(`
                INSERT INTO guild_settings (guild_id, setting_key, setting_value)
                VALUES
                    (?, 'leveling_enabled', '1'),
                    (?, 'leveling_channel', ?),
                    (?, 'leveling_message', ?)
                ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
            `, [
                GUILD_ID,
                GUILD_ID, announcementsChannel?.id || '',
                GUILD_ID, '🌱 {user} has grown to **Level {level}**! Keep cultivating that knowledge!'
            ]);
            console.log('   ✅ Configured leveling system');

            // Step 8: Post marketplace rules
            console.log('\n🏪 Setting up marketplace...');
            const marketRulesChannel = guild.channels.cache.find(c => c.name.includes('marketplace-rules'));
            if (marketRulesChannel) {
                const marketEmbed = new EmbedBuilder()
                    .setColor(COLORS.gold)
                    .setTitle('🏪 Marketplace Rules & Guidelines')
                    .setDescription('Read these rules before participating in the marketplace!')
                    .addFields(
                        {
                            name: '📋 Requirements',
                            value: '• Must have the **Verified Trader** role to post\n• Must be a member for at least 7 days\n• Must have verified 21+ status',
                            inline: false
                        },
                        {
                            name: '✅ Allowed',
                            value: '• Growing equipment (lights, tents, fans, etc.)\n• Nutrients and growing supplies\n• Seeds from legal sources\n• DIY equipment and accessories\n• Grow-related merchandise',
                            inline: false
                        },
                        {
                            name: '❌ Not Allowed',
                            value: '• Illegal substances of any kind\n• Clones or live plants\n• Anything against Discord ToS\n• Scams or fraudulent items',
                            inline: false
                        },
                        {
                            name: '💰 Transaction Safety',
                            value: '• Use secure payment methods\n• Get feedback before large transactions\n• Screenshot all agreements\n• Report suspicious activity to staff',
                            inline: false
                        },
                        {
                            name: '📝 Posting Format',
                            value: '**For Sale:**\n`[FS] Item Name - Price - Location - Shipping Y/N`\n\n**Wanted:**\n`[WTB] Item Name - Budget - Location`\n\n**Trade:**\n`[WTT] Have: Item - Want: Item`',
                            inline: false
                        }
                    )
                    .setFooter({ text: 'Staff are not responsible for transactions. Trade at your own risk.' });

                await marketRulesChannel.send({ embeds: [marketEmbed] });
                console.log('   ✅ Posted marketplace rules');
            }

            console.log('\n================================');
            console.log('🎉 Server setup complete!');
            console.log('================================\n');
            console.log('📝 Next steps:');
            console.log('   1. Set up reaction roles handler if not already active');
            console.log('   2. Configure moderation logging channel');
            console.log('   3. Add staff members to appropriate roles');
            console.log('   4. Test verification flow');
            console.log('   5. Invite members!\n');

        } catch (error) {
            console.error('❌ Error during setup:', error);
        }

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
