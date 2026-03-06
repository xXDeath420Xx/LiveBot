/**
 * Set up additional Growmie features:
 * - Welcome channel for verified members
 * - Trader reputation system
 * - Mod logs channels
 * - Giveaways channel
 */

import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🔧 Setting up additional Growmie features...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);

        // Get key roles
        const verifiedRole = guild.roles.cache.find(r => r.name.includes('Verified Growmie'));
        const traderRole = guild.roles.cache.find(r => r.name.includes('Verified Trader'));
        const staffRoles = guild.roles.cache.filter(r =>
            r.name.includes('Garden Master') ||
            r.name.includes('Greenhouse Guard') ||
            r.name.includes('Garden Helper')
        );

        // Get categories
        const welcomeCategory = guild.channels.cache.find(c =>
            c.type === ChannelType.GuildCategory && c.name.includes('WELCOME')
        );
        const marketplaceCategory = guild.channels.cache.find(c =>
            c.type === ChannelType.GuildCategory && c.name.includes('MARKETPLACE')
        );
        const staffCategory = guild.channels.cache.find(c =>
            c.type === ChannelType.GuildCategory && c.name.includes('STAFF')
        );

        // =========================================
        // 1. WELCOME CHANNEL (for verified members)
        // =========================================
        console.log('═'.repeat(50));
        console.log('📝 Setting up Welcome Channel');
        console.log('═'.repeat(50));

        let welcomeChannel = guild.channels.cache.find(c =>
            c.name.includes('welcome') && c.name.includes('verified')
        );

        if (!welcomeChannel) {
            welcomeChannel = await guild.channels.create({
                name: '🎉-welcome-growmies',
                type: ChannelType.GuildText,
                parent: welcomeCategory?.id,
                topic: 'Welcome newly verified members to the community!',
                position: 3, // After introductions
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: [PermissionFlagsBits.ViewChannel]
                    },
                    {
                        id: verifiedRole.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                        deny: [PermissionFlagsBits.SendMessages]
                    }
                ],
                reason: 'Welcome channel for verified members'
            });
            console.log(`✅ Created: #${welcomeChannel.name}`);
        } else {
            console.log(`ℹ️  Already exists: #${welcomeChannel.name}`);
        }

        // Configure welcome settings in database
        await pool.execute(`
            INSERT INTO welcome_settings (guild_id, channel_id, message, goodbye_enabled)
            VALUES (?, ?, ?, FALSE)
            ON DUPLICATE KEY UPDATE
                channel_id = VALUES(channel_id),
                message = VALUES(message)
        `, [
            GUILD_ID,
            welcomeChannel.id,
            '🌱 **Welcome to the garden, {user}!**\n\nYou\'re now a verified Growmie! Feel free to:\n• Introduce yourself in <#1452977953376960585>\n• Pick your growing style roles\n• Check out the grow channels\n• Share your grows!\n\nHappy growing! 🌿'
        ]);
        console.log('✅ Configured welcome messages');

        // =========================================
        // 2. TRADER REPUTATION SYSTEM
        // =========================================
        console.log('\n' + '═'.repeat(50));
        console.log('📝 Setting up Trader Reputation System');
        console.log('═'.repeat(50));

        // Create trader rep table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS trader_reputation (
                id INT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                user_id VARCHAR(20) NOT NULL,
                voucher_id VARCHAR(20) NOT NULL,
                trade_type ENUM('sale', 'purchase', 'trade') DEFAULT 'trade',
                rating TINYINT UNSIGNED DEFAULT 5,
                comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user (guild_id, user_id)
            )
        `);

        // Create trader tiers table
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS trader_tiers (
                guild_id VARCHAR(20) PRIMARY KEY,
                tier1_name VARCHAR(50) DEFAULT '🌱 New Trader',
                tier1_min INT DEFAULT 0,
                tier1_role_id VARCHAR(20),
                tier2_name VARCHAR(50) DEFAULT '🌿 Trusted Trader',
                tier2_min INT DEFAULT 3,
                tier2_role_id VARCHAR(20),
                tier3_name VARCHAR(50) DEFAULT '🌳 Veteran Trader',
                tier3_min INT DEFAULT 10,
                tier3_role_id VARCHAR(20),
                tier4_name VARCHAR(50) DEFAULT '👑 Elite Trader',
                tier4_min INT DEFAULT 25,
                tier4_role_id VARCHAR(20)
            )
        `);

        // Create additional trader roles
        let trustedTrader = guild.roles.cache.find(r => r.name.includes('Trusted Trader'));
        if (!trustedTrader) {
            trustedTrader = await guild.roles.create({
                name: '🌿 Trusted Trader',
                color: 0x57F287,
                reason: 'Trader reputation tier 2'
            });
            console.log(`✅ Created role: ${trustedTrader.name}`);
        }

        let veteranTrader = guild.roles.cache.find(r => r.name.includes('Veteran Trader'));
        if (!veteranTrader) {
            veteranTrader = await guild.roles.create({
                name: '🌳 Veteran Trader',
                color: 0x3498DB,
                reason: 'Trader reputation tier 3'
            });
            console.log(`✅ Created role: ${veteranTrader.name}`);
        }

        let eliteTrader = guild.roles.cache.find(r => r.name.includes('Elite Trader'));
        if (!eliteTrader) {
            eliteTrader = await guild.roles.create({
                name: '👑 Elite Trader',
                color: 0xF1C40F,
                reason: 'Trader reputation tier 4'
            });
            console.log(`✅ Created role: ${eliteTrader.name}`);
        }

        // Save tier config
        await pool.execute(`
            INSERT INTO trader_tiers (guild_id, tier1_role_id, tier2_role_id, tier3_role_id, tier4_role_id)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                tier1_role_id = VALUES(tier1_role_id),
                tier2_role_id = VALUES(tier2_role_id),
                tier3_role_id = VALUES(tier3_role_id),
                tier4_role_id = VALUES(tier4_role_id)
        `, [GUILD_ID, traderRole?.id, trustedTrader.id, veteranTrader.id, eliteTrader.id]);

        console.log('✅ Configured trader reputation tiers');

        // =========================================
        // 3. MOD LOGS CHANNELS
        // =========================================
        console.log('\n' + '═'.repeat(50));
        console.log('📝 Setting up Mod Logs');
        console.log('═'.repeat(50));

        const logChannels = [
            { name: '📝-message-logs', topic: 'Message edits and deletions' },
            { name: '👥-member-logs', topic: 'Member joins, leaves, and updates' },
            { name: '🔨-mod-actions', topic: 'Bans, kicks, timeouts, warnings' },
            { name: '🔗-invite-logs', topic: 'Invite tracking and usage' }
        ];

        const createdLogChannels = {};

        for (const logConfig of logChannels) {
            let channel = guild.channels.cache.find(c => c.name === logConfig.name);

            if (!channel) {
                channel = await guild.channels.create({
                    name: logConfig.name,
                    type: ChannelType.GuildText,
                    parent: staffCategory?.id,
                    topic: logConfig.topic,
                    permissionOverwrites: [
                        {
                            id: guild.roles.everyone.id,
                            deny: [PermissionFlagsBits.ViewChannel]
                        }
                    ],
                    reason: 'Mod logging channel'
                });
                console.log(`✅ Created: #${channel.name}`);
            } else {
                console.log(`ℹ️  Already exists: #${channel.name}`);
            }

            createdLogChannels[logConfig.name] = channel.id;
        }

        // Configure logging in database
        await pool.execute(`
            INSERT INTO logging_config (guild_id, log_channel_id, message_log_channel_id, member_log_channel_id, mod_log_channel_id)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                log_channel_id = VALUES(log_channel_id),
                message_log_channel_id = VALUES(message_log_channel_id),
                member_log_channel_id = VALUES(member_log_channel_id),
                mod_log_channel_id = VALUES(mod_log_channel_id)
        `, [
            GUILD_ID,
            createdLogChannels['📝-message-logs'],
            createdLogChannels['📝-message-logs'],
            createdLogChannels['👥-member-logs'],
            createdLogChannels['🔨-mod-actions']
        ]);

        console.log('✅ Configured logging settings');

        // =========================================
        // 4. GIVEAWAYS CHANNEL
        // =========================================
        console.log('\n' + '═'.repeat(50));
        console.log('📝 Setting up Giveaways Channel');
        console.log('═'.repeat(50));

        let giveawayChannel = guild.channels.cache.find(c => c.name.includes('giveaway'));

        if (!giveawayChannel) {
            giveawayChannel = await guild.channels.create({
                name: '🎁-giveaways',
                type: ChannelType.GuildText,
                parent: marketplaceCategory?.id,
                topic: 'Community giveaways! React to enter.',
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: [PermissionFlagsBits.ViewChannel]
                    },
                    {
                        id: traderRole?.id || verifiedRole.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions],
                        deny: [PermissionFlagsBits.SendMessages]
                    }
                ],
                reason: 'Giveaways channel'
            });
            console.log(`✅ Created: #${giveawayChannel.name}`);
        } else {
            console.log(`ℹ️  Already exists: #${giveawayChannel.name}`);
        }

        // =========================================
        // 5. GROW TIPS TABLE (for auto-posting)
        // =========================================
        console.log('\n' + '═'.repeat(50));
        console.log('📝 Setting up Grow Tips System');
        console.log('═'.repeat(50));

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS grow_tips (
                id INT AUTO_INCREMENT PRIMARY KEY,
                category ENUM('general', 'nutrients', 'lighting', 'environment', 'pests', 'harvest', 'beginner') DEFAULT 'general',
                title VARCHAR(255) NOT NULL,
                content TEXT NOT NULL,
                source VARCHAR(255),
                source_url VARCHAR(500),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_posted TIMESTAMP NULL,
                times_posted INT DEFAULT 0
            )
        `);

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS grow_tips_config (
                guild_id VARCHAR(20) PRIMARY KEY,
                channel_id VARCHAR(20),
                enabled BOOLEAN DEFAULT FALSE,
                post_time TIME DEFAULT '12:00:00',
                post_days VARCHAR(50) DEFAULT 'mon,wed,fri'
            )
        `);

        // Get general channel for tips
        const generalChannel = guild.channels.cache.find(c => c.name.includes('general'));

        await pool.execute(`
            INSERT INTO grow_tips_config (guild_id, channel_id, enabled, post_time, post_days)
            VALUES (?, ?, TRUE, '12:00:00', 'mon,wed,fri')
            ON DUPLICATE KEY UPDATE
                channel_id = VALUES(channel_id),
                enabled = TRUE
        `, [GUILD_ID, generalChannel?.id]);

        console.log('✅ Created grow tips tables');
        console.log('ℹ️  Tips will need to be populated (I\'ll create a seeder)');

        // =========================================
        // SUMMARY
        // =========================================
        console.log('\n' + '═'.repeat(50));
        console.log('🎉 SETUP COMPLETE');
        console.log('═'.repeat(50));
        console.log('\n✅ Welcome channel: #' + welcomeChannel.name);
        console.log('✅ Trader reputation: 4 tiers configured');
        console.log('✅ Mod logs: 4 channels created');
        console.log('✅ Giveaways: #' + giveawayChannel.name);
        console.log('✅ Grow tips: Tables ready');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
