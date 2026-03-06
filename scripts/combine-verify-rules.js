/**
 * Combine rules and verification into one message
 */

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const VERIFY_CHANNEL_ID = '1452977946217418826';
const RULES_MSG_ID = '1452978014114811936';
const VERIFY_MSG_ID = '1452981376532877476';

async function main() {
    console.log('📜 Combining Rules + Verification...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}`);

        const guild = client.guilds.cache.get(GUILD_ID);
        const verifyChannel = guild.channels.cache.get(VERIFY_CHANNEL_ID);

        if (!verifyChannel) {
            console.error('❌ Verify channel not found!');
            process.exit(1);
        }

        console.log(`📍 Channel: ${verifyChannel.name}`);

        // Fetch both messages
        let rulesMsg, verifyMsg;
        try {
            rulesMsg = await verifyChannel.messages.fetch(RULES_MSG_ID).catch(() => null);
            verifyMsg = await verifyChannel.messages.fetch(VERIFY_MSG_ID).catch(() => null);
        } catch (e) {
            // Messages might be in different channels, search all
            for (const [id, channel] of guild.channels.cache) {
                if (!channel.isTextBased()) continue;
                try {
                    if (!rulesMsg) rulesMsg = await channel.messages.fetch(RULES_MSG_ID).catch(() => null);
                    if (!verifyMsg) verifyMsg = await channel.messages.fetch(VERIFY_MSG_ID).catch(() => null);
                    if (rulesMsg && verifyMsg) break;
                } catch (e) {}
            }
        }

        console.log(`Rules message: ${rulesMsg ? 'Found' : 'Not found'}`);
        console.log(`Verify message: ${verifyMsg ? 'Found' : 'Not found'}`);

        // Get intro channel for the link
        const introChannel = guild.channels.cache.find(c => c.name.includes('introductions'));

        // Create combined embed
        const combinedEmbed = new EmbedBuilder()
            .setColor(0x228B22)
            .setTitle('🌱 Growmie Community Rules & Verification')
            .setDescription(
                'Welcome to the Growmie community! Please read the rules below and react with ✅ to verify and gain access.\n\n' +
                '**This is an age-restricted community (18+)**'
            )
            .addFields(
                {
                    name: '1️⃣ Age Requirement',
                    value: 'You must be **18 years or older** to participate in this community. This is strictly enforced.',
                    inline: false
                },
                {
                    name: '2️⃣ Respect Everyone',
                    value: 'Treat all members with respect. No harassment, hate speech, discrimination, or personal attacks.',
                    inline: false
                },
                {
                    name: '3️⃣ No Spam',
                    value: 'No spamming, excessive self-promotion, or advertising without permission except where explicitly allowed (Market channels).',
                    inline: false
                },
                {
                    name: '4️⃣ Use Correct Channels',
                    value: 'Post content in the appropriate channels. Use bot commands in #bot-commands.',
                    inline: false
                },
                {
                    name: '5️⃣ Marketplace Rules',
                    value: 'Trading requires the Verified Trader role. No scamming - report suspicious activity immediately.',
                    inline: false
                },
                {
                    name: '6️⃣ NSFW Policy',
                    value: 'Keep content appropriate. No explicit content outside of properly marked channels.',
                    inline: false
                },
                {
                    name: '7️⃣ Listen to Staff',
                    value: 'Follow instructions from Garden Masters and Greenhouse Guards. Their decisions are final.',
                    inline: false
                },
                {
                    name: '8️⃣ Have Fun!',
                    value: 'This is a community for passionate growers. Share knowledge, help each other, and enjoy the journey!',
                    inline: false
                },
                {
                    name: '\u200B',
                    value: '━━━━━━━━━━━━━━━━━━━━━━',
                    inline: false
                },
                {
                    name: '✅ How to Verify',
                    value:
                        '**React with ✅ below to confirm:**\n' +
                        '• You are at least 18 years old\n' +
                        '• You have read and agree to the rules above\n' +
                        '• You understand this is a private community\n\n' +
                        `Once verified, head to ${introChannel ? `<#${introChannel.id}>` : '#introductions'} to introduce yourself and pick your roles!`,
                    inline: false
                }
            )
            .setFooter({ text: 'Breaking rules may result in warnings, mutes, or bans. | False verification = permanent ban.' })
            .setTimestamp();

        // Delete old messages
        if (rulesMsg) {
            await rulesMsg.delete().catch(() => {});
            console.log('🗑️  Deleted old rules message');
        }
        if (verifyMsg) {
            await verifyMsg.delete().catch(() => {});
            console.log('🗑️  Deleted old verify message');
        }

        // Also check and delete from the rules channel
        const rulesChannel = guild.channels.cache.find(c => c.name === '📜-rules');
        if (rulesChannel) {
            const rulesChannelMsgs = await rulesChannel.messages.fetch({ limit: 10 });
            for (const msg of rulesChannelMsgs.values()) {
                if (msg.author.id === client.user.id && msg.embeds.length > 0) {
                    await msg.delete().catch(() => {});
                    console.log('🗑️  Deleted rules from #rules channel');
                }
            }
        }

        // Post combined message
        const newMsg = await verifyChannel.send({ embeds: [combinedEmbed] });
        await newMsg.react('✅');
        console.log('✅ Posted combined rules + verification message');
        console.log(`   Message ID: ${newMsg.id}`);

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
