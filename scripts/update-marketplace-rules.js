/**
 * Update marketplace rules message
 */

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const MARKETPLACE_RULES_CHANNEL_ID = '1452977991440269374';

async function main() {
    console.log('🔧 Updating marketplace rules...\n');

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
        const channel = guild.channels.cache.get(MARKETPLACE_RULES_CHANNEL_ID);

        // Delete old messages from bot
        const messages = await channel.messages.fetch({ limit: 10 });
        for (const msg of messages.values()) {
            if (msg.author.id === client.user.id) {
                await msg.delete().catch(() => {});
            }
        }

        // Create new embed with custom rules
        const marketplaceEmbed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle('💰 Marketplace Rules & Guidelines')
            .setDescription(
                `Welcome to the Growmie Marketplace! To protect our community, please follow these rules carefully.\n\n` +
                `**React with 💰 below to agree to these rules and gain access to trading channels.**`
            )
            .addFields(
                {
                    name: '📜 General Rules',
                    value:
                        `1️⃣ **No scamming** - Scammers will be permanently banned\n` +
                        `2️⃣ **Be honest** - Accurately describe all items\n` +
                        `3️⃣ **Price fairly** - No price gouging or lowballing\n` +
                        `4️⃣ **Use proper channels** - Post in the correct category\n` +
                        `5️⃣ **One bump per 24h** - No excessive reposting`,
                    inline: false
                },
                {
                    name: '🔒 Safety Guidelines',
                    value:
                        `• **Never share personal info** publicly (please take addresses or meetups to DMs for your own safety, don't dox yourself even in a private server)\n` +
                        `• **Use secure payment methods** when trading\n` +
                        `• **Meet in public** if doing local trades\n` +
                        `• **Report suspicious behavior** to staff`,
                    inline: false
                },
                {
                    name: '📋 Listing Requirements',
                    value:
                        `• Clear photos of the item\n` +
                        `• Accurate description and condition\n` +
                        `• Price (or "OBO" / "Trade Only")\n` +
                        `• Shipping availability/preferences\n` +
                        `• Payment methods accepted`,
                    inline: false
                },
                {
                    name: '⚠️ Prohibited Items',
                    value:
                        `• Counterfeit or stolen goods\n` +
                        `• Your Mom's Sex Toys\n` +
                        `• Pictures of your butthole... butthole should be free - @HolyDabRip420's dm's are open ;)`,
                    inline: false
                },
                {
                    name: '✅ Agreement',
                    value:
                        `By reacting with 💰 below, you agree to:\n` +
                        `• Follow all marketplace rules\n` +
                        `• Trade honestly and fairly\n` +
                        `• Accept responsibility for your trades\n` +
                        `• Report rule violations to staff`,
                    inline: false
                }
            )
            .setFooter({ text: 'React with 💰 to unlock trading channels!' })
            .setTimestamp();

        const newMessage = await channel.send({ embeds: [marketplaceEmbed] });
        await newMessage.react('💰');

        console.log(`✅ Posted new marketplace rules: ${newMessage.id}`);

        // Update database with new message ID
        await pool.execute(`
            UPDATE reaction_role_panels
            SET message_id = ?
            WHERE channel_id = ? AND guild_id = ?
        `, [newMessage.id, MARKETPLACE_RULES_CHANNEL_ID, GUILD_ID]);

        console.log('✅ Updated database with new message ID');

        console.log('\n🎉 Done!');
        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
