import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const GUILD_ID = '953890977880358932';
const CHANNEL_ID = '1377507500198203402';
const MESSAGE_IDS = ['1443963415260303534', '1443583392435146762'];

async function editMessages() {
    // Get all custom bots from database
    const [customBots] = await pool.execute(
        'SELECT bot_id, bot_name, bot_token FROM custom_bots'
    );

    console.log(`Found ${customBots.length} custom bots`);

    // Try main bot first
    const mainClient = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    const clients = [{ client: mainClient, token: process.env.DISCORD_TOKEN, name: 'Main Bot' }];

    // Add custom bots (decrypt tokens)
    for (const bot of customBots) {
        const botClient = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
        });

        // Decrypt the bot token
        let decryptedToken = bot.bot_token;
        try {
            if (typeof bot.bot_token === 'string' && bot.bot_token.startsWith('{')) {
                const tokenObj = JSON.parse(bot.bot_token);
                decryptedToken = encryption.decrypt(tokenObj);
            }
        } catch (err) {
            console.log(`Could not decrypt token for ${bot.bot_name}: ${err.message}`);
        }

        clients.push({ client: botClient, token: decryptedToken, name: bot.bot_name });
    }

    for (const { client, token, name } of clients) {
        try {
            await client.login(token);
            console.log(`\nLogged in as ${client.user.tag} (${name})`);

            // Try to fetch the guild directly
            let guild;
            try {
                guild = await client.guilds.fetch(GUILD_ID);
            } catch (e) {
                console.log(`  Not in guild ${GUILD_ID}`);
                await client.destroy();
                continue;
            }

            if (!guild) {
                console.log(`  Not in guild ${GUILD_ID}`);
                await client.destroy();
                continue;
            }

            console.log(`  Found guild: ${guild.name}`);

            // Fetch the channel directly
            let channel;
            try {
                channel = await client.channels.fetch(CHANNEL_ID);
            } catch (e) {
                console.log(`  Channel ${CHANNEL_ID} not found or no access`);
                await client.destroy();
                continue;
            }

            if (!channel) {
                console.log(`  Channel ${CHANNEL_ID} not found`);
                await client.destroy();
                continue;
            }

            console.log(`  Found channel: #${channel.name}`);

            for (const msgId of MESSAGE_IDS) {
                try {
                    const message = await channel.messages.fetch(msgId);
                    console.log(`\n  Found message ${msgId}`);
                    console.log(`    Author: ${message.author.tag} (${message.author.id})`);
                    console.log(`    Bot ID: ${client.user.id}`);

                    if (message.author.id !== client.user.id) {
                        console.log(`    ⚠️ Not our message, skipping...`);
                        continue;
                    }

                    const existingEmbed = message.embeds[0];
                    if (!existingEmbed) {
                        console.log(`    ⚠️ No embed found, skipping...`);
                        continue;
                    }

                    const title = existingEmbed.title || '';
                    const description = existingEmbed.description || '';
                    const username = title.replace(' uploaded a new TikTok!', '');

                    // Find TikTok URL
                    let tiktokUrl = '';
                    if (message.components.length > 0 && message.components[0].components.length > 0) {
                        const button = message.components[0].components[0];
                        if (button && button.url) {
                            tiktokUrl = button.url;
                        }
                    }

                    // Get thumbnail from video if available
                    let thumbnail = existingEmbed.thumbnail?.url || null;

                    // Try to get thumbnail from attachment metadata or TikWM
                    if (!thumbnail && message.attachments.size > 0) {
                        // The attachment is a video, we'd need to call TikWM to get thumbnail
                        // For now, we'll fetch it from the TikTok URL
                        if (tiktokUrl) {
                            try {
                                const axios = (await import('axios')).default;
                                const response = await axios.get('https://tikwm.com/api/', {
                                    params: { url: tiktokUrl },
                                    timeout: 10000
                                });
                                if (response.data?.data?.cover) {
                                    thumbnail = response.data.data.cover;
                                    console.log(`    Got thumbnail from TikWM: ${thumbnail.substring(0, 50)}...`);
                                }
                            } catch (err) {
                                console.log(`    Could not fetch thumbnail from TikWM`);
                            }
                        }
                    }

                    console.log(`    Username: ${username}`);
                    console.log(`    TikTok URL: ${tiktokUrl}`);

                    if (!tiktokUrl) {
                        console.log(`    ⚠️ No TikTok URL found, skipping...`);
                        continue;
                    }

                    // Create new FreshTok-style embed
                    const newEmbed = new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle(`${username} uploaded a new TikTok!`)
                        .setDescription(description)
                        .setTimestamp(existingEmbed.timestamp ? new Date(existingEmbed.timestamp) : new Date());

                    if (thumbnail) {
                        newEmbed.setThumbnail(thumbnail);
                    }

                    // Create buttons
                    const viewButton = new ButtonBuilder()
                        .setLabel('View on TikTok')
                        .setStyle(ButtonStyle.Link)
                        .setURL(tiktokUrl);

                    const analyticsButton = new ButtonBuilder()
                        .setLabel('View Analytics')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://certifriedmultitool.com/analytics/${username}`);

                    const row = new ActionRowBuilder().addComponents(viewButton, analyticsButton);

                    // Edit the message
                    await message.edit({
                        embeds: [newEmbed],
                        components: [row]
                    });

                    console.log(`    ✅ Updated message ${msgId}`);

                } catch (err) {
                    if (err.code === 10008) {
                        console.log(`  Message ${msgId} not found in this channel`);
                    } else {
                        console.log(`  Error with message ${msgId}: ${err.message}`);
                    }
                }
            }

            await client.destroy();

        } catch (err) {
            console.log(`Failed to login ${name}: ${err.message}`);
            try { await client.destroy(); } catch (e) {}
        }
    }

    console.log('\nDone!');
    await pool.end();
    process.exit(0);
}

editMessages().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
