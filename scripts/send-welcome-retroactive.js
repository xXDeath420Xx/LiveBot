/**
 * Send retroactive welcome messages to verified users (with canvas cards)
 */

import { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { generateWelcomeCard } from '../utils/welcomeCard.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const WELCOME_CHANNEL_ID = '1452999239293603994';

async function main() {
    console.log('🔧 Sending retroactive welcome messages...\n');

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
        const welcomeChannel = guild.channels.cache.get(WELCOME_CHANNEL_ID);
        const verifiedRole = guild.roles.cache.find(r => r.name.includes('Verified Growmie'));

        if (!welcomeChannel) {
            console.log('❌ Welcome channel not found!');
            process.exit(1);
        }

        // Delete old welcome messages from bot (both plain text and embeds)
        const oldMessages = await welcomeChannel.messages.fetch({ limit: 20 });
        for (const msg of oldMessages.values()) {
            if (msg.author.id === client.user.id) {
                await msg.delete().catch(() => {});
            }
        }
        console.log('🗑️  Deleted old welcome messages');

        console.log(`📢 Welcome channel: #${welcomeChannel.name}`);
        console.log(`🌱 Verified role: ${verifiedRole?.name}\n`);

        // Fetch all members
        await guild.members.fetch();

        // Find members with the verified role (excluding bots)
        const verifiedMembers = guild.members.cache.filter(m =>
            !m.user.bot && m.roles.cache.has(verifiedRole?.id)
        );

        console.log(`Found ${verifiedMembers.size} verified member(s)\n`);

        for (const [id, member] of verifiedMembers) {
            // Generate welcome card with cannabis background
            const welcomeCardBuffer = await generateWelcomeCard(member, guild.name);
            const attachment = new AttachmentBuilder(welcomeCardBuffer, { name: 'welcome.png' });

            const embed = new EmbedBuilder()
                .setColor(0x2ECC71)
                .setImage('attachment://welcome.png')
                .addFields(
                    {
                        name: '🌿 Get Started',
                        value: '• Introduce yourself in <#1452977953376960585>\n• Pick your growing style roles\n• Check out the grow channels\n• Share your grows!',
                        inline: false
                    }
                )
                .setFooter({ text: 'Happy growing! 🪴' })
                .setTimestamp();

            await welcomeChannel.send({ embeds: [embed], files: [attachment] });
            console.log(`✅ Sent welcome card for: ${member.user.tag}`);
        }

        console.log('\n🎉 Done!');
        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
