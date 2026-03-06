/**
 * Check and fix role reactions on the role selection message
 */

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const ROLE_MESSAGE_ID = '1452978016564150272';

async function main() {
    console.log('🔧 Checking role reactions...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessageReactions
        ]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);

        // Get the message
        let message;
        for (const [id, channel] of guild.channels.cache) {
            if (!channel.isTextBased()) continue;
            try {
                message = await channel.messages.fetch(ROLE_MESSAGE_ID);
                if (message) {
                    console.log(`📬 Found message in #${channel.name}`);
                    break;
                }
            } catch (e) {}
        }

        if (!message) {
            console.log('❌ Message not found!');
            process.exit(1);
        }

        // Get database mappings
        const [mappings] = await pool.execute(`
            SELECT m.*, p.panel_name
            FROM reaction_role_mappings m
            JOIN reaction_role_panels p ON m.panel_id = p.id
            WHERE p.message_id = ?
        `, [ROLE_MESSAGE_ID]);

        console.log(`\n📋 Database has ${mappings.length} role mappings:`);
        const expectedEmojis = [];
        for (const m of mappings) {
            const role = guild.roles.cache.get(m.role_id);
            console.log(`   ${m.emoji_id} -> ${role?.name || 'NOT FOUND'}`);
            expectedEmojis.push(m.emoji_id);
        }

        // Check current reactions on message
        console.log(`\n📊 Current reactions on message: ${message.reactions.cache.size}`);
        const currentEmojis = [];
        for (const [emoji, reaction] of message.reactions.cache) {
            currentEmojis.push(emoji);
            console.log(`   ${emoji}: ${reaction.count} reactions`);
        }

        // Find missing reactions
        const missingEmojis = expectedEmojis.filter(e => !currentEmojis.includes(e));
        console.log(`\n⚠️  Missing ${missingEmojis.length} reactions from message:`);
        for (const emoji of missingEmojis) {
            console.log(`   ${emoji}`);
        }

        // Add missing reactions
        if (missingEmojis.length > 0) {
            console.log('\n🔧 Adding missing reactions...');
            for (const emoji of missingEmojis) {
                try {
                    await message.react(emoji);
                    console.log(`   ✅ Added ${emoji}`);
                } catch (e) {
                    console.log(`   ❌ Failed to add ${emoji}: ${e.message}`);
                }
            }
        }

        console.log('\n🎉 Done!');
        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
