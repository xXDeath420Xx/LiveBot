/**
 * Update Growmie Rules - Fix numbering
 */

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('📜 Updating Growmie Rules...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    if (bots.length === 0) {
        console.error('❌ Bot not found!');
        process.exit(1);
    }

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}`);

        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error('❌ Guild not found!');
            process.exit(1);
        }

        const rulesChannel = guild.channels.cache.find(c => c.name === '📜-rules');
        if (!rulesChannel) {
            console.error('❌ Rules channel not found!');
            process.exit(1);
        }

        console.log(`📍 Found channel: ${rulesChannel.name}`);

        // Find and delete the old rules message
        const messages = await rulesChannel.messages.fetch({ limit: 10 });
        const oldRulesMsg = messages.find(m =>
            m.author.id === client.user.id &&
            m.embeds.length > 0 &&
            m.embeds[0].title?.includes('Rules')
        );

        if (oldRulesMsg) {
            await oldRulesMsg.delete();
            console.log('🗑️  Deleted old rules message');
        }

        // Post new rules with correct numbering (1-8)
        const rulesEmbed = new EmbedBuilder()
            .setColor(0x228B22)
            .setTitle('🌱 Growmie Community Rules')
            .setDescription('Welcome to the Growmie community! Please read and follow these rules to keep our garden flourishing.')
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
                }
            )
            .setFooter({ text: 'Breaking rules may result in warnings, mutes, or bans.' })
            .setTimestamp();

        await rulesChannel.send({ embeds: [rulesEmbed] });
        console.log('✅ Posted updated rules (1-8)');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
