/**
 * Simplified setup for Growmie features
 */

import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🔧 Setting up Growmie features...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);
        const verifiedRole = guild.roles.cache.find(r => r.name.includes('Verified Growmie'));
        const traderRole = guild.roles.cache.find(r => r.name.includes('Verified Trader'));

        // Find categories
        const welcomeCategory = guild.channels.cache.find(c =>
            c.type === ChannelType.GuildCategory && c.name.includes('WELCOME')
        );
        const marketplaceCategory = guild.channels.cache.find(c =>
            c.type === ChannelType.GuildCategory && c.name.includes('MARKETPLACE')
        );
        const staffCategory = guild.channels.cache.find(c =>
            c.type === ChannelType.GuildCategory && c.name.includes('STAFF')
        );

        // 1. Welcome Channel
        console.log('1️⃣ Creating welcome channel...');
        let welcomeChannel = guild.channels.cache.find(c => c.name.includes('welcome-growmies'));
        if (!welcomeChannel) {
            welcomeChannel = await guild.channels.create({
                name: '🎉-welcome-growmies',
                type: ChannelType.GuildText,
                parent: welcomeCategory?.id,
                permissionOverwrites: [
                    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }
                ]
            });
            console.log('   ✅ Created #' + welcomeChannel.name);
        } else {
            console.log('   ℹ️  Already exists');
        }

        // 2. Trader Roles
        console.log('2️⃣ Creating trader roles...');
        let trustedTrader = guild.roles.cache.find(r => r.name.includes('Trusted Trader'));
        if (!trustedTrader) {
            trustedTrader = await guild.roles.create({ name: '🌿 Trusted Trader', color: 0x57F287 });
            console.log('   ✅ Created ' + trustedTrader.name);
        }

        let veteranTrader = guild.roles.cache.find(r => r.name.includes('Veteran Trader'));
        if (!veteranTrader) {
            veteranTrader = await guild.roles.create({ name: '🌳 Veteran Trader', color: 0x3498DB });
            console.log('   ✅ Created ' + veteranTrader.name);
        }

        let eliteTrader = guild.roles.cache.find(r => r.name.includes('Elite Trader'));
        if (!eliteTrader) {
            eliteTrader = await guild.roles.create({ name: '👑 Elite Trader', color: 0xF1C40F });
            console.log('   ✅ Created ' + eliteTrader.name);
        }

        // 3. Log Channels
        console.log('3️⃣ Creating log channels...');
        const logChannelNames = ['📝-message-logs', '👥-member-logs', '🔨-mod-actions', '🔗-invite-logs'];
        for (const name of logChannelNames) {
            let channel = guild.channels.cache.find(c => c.name === name);
            if (!channel) {
                channel = await guild.channels.create({
                    name: name,
                    type: ChannelType.GuildText,
                    parent: staffCategory?.id,
                    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }]
                });
                console.log('   ✅ Created #' + name);
            } else {
                console.log('   ℹ️  #' + name + ' exists');
            }
        }

        // 4. Giveaways Channel
        console.log('4️⃣ Creating giveaways channel...');
        let giveawayChannel = guild.channels.cache.find(c => c.name.includes('giveaway'));
        if (!giveawayChannel) {
            giveawayChannel = await guild.channels.create({
                name: '🎁-giveaways',
                type: ChannelType.GuildText,
                parent: marketplaceCategory?.id,
                permissionOverwrites: [
                    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: traderRole?.id || verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions], deny: [PermissionFlagsBits.SendMessages] }
                ]
            });
            console.log('   ✅ Created #' + giveawayChannel.name);
        } else {
            console.log('   ℹ️  Already exists');
        }

        console.log('\n🎉 Done! Channels and roles created.');
        console.log('\nNow creating database tables...');

        // Create tables
        try {
            await pool.execute(`
                CREATE TABLE IF NOT EXISTS trader_reputation (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    voucher_id VARCHAR(20) NOT NULL,
                    trade_type VARCHAR(20) DEFAULT 'trade',
                    rating TINYINT UNSIGNED DEFAULT 5,
                    comment TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_user (guild_id, user_id)
                )
            `);
            console.log('✅ Created trader_reputation table');
        } catch (e) {
            console.log('⚠️  trader_reputation: ' + e.message);
        }

        try {
            await pool.execute(`
                CREATE TABLE IF NOT EXISTS trader_tiers (
                    guild_id VARCHAR(20) PRIMARY KEY,
                    tier1_role_id VARCHAR(20),
                    tier2_role_id VARCHAR(20),
                    tier3_role_id VARCHAR(20),
                    tier4_role_id VARCHAR(20)
                )
            `);
            console.log('✅ Created trader_tiers table');
        } catch (e) {
            console.log('⚠️  trader_tiers: ' + e.message);
        }

        try {
            await pool.execute(`
                CREATE TABLE IF NOT EXISTS grow_tips (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    category VARCHAR(50) DEFAULT 'general',
                    title VARCHAR(255) NOT NULL,
                    content TEXT NOT NULL,
                    source VARCHAR(255),
                    source_url VARCHAR(500),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_posted TIMESTAMP NULL,
                    times_posted INT DEFAULT 0
                )
            `);
            console.log('✅ Created grow_tips table');
        } catch (e) {
            console.log('⚠️  grow_tips: ' + e.message);
        }

        console.log('\n✅ All setup complete!');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
