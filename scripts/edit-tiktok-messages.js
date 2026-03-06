import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const MESSAGE_IDS = ['1443963415260303534', '1443583392435146762'];

async function findAndEditMessages() {
    console.log('Searching for messages...');

    for (const guild of client.guilds.cache.values()) {
        console.log(`Checking guild: ${guild.name}`);

        for (const channel of guild.channels.cache.values()) {
            if (!channel.isTextBased()) continue;

            for (const msgId of MESSAGE_IDS) {
                try {
                    const message = await channel.messages.fetch(msgId);
                    if (message) {
                        console.log(`\nFound message ${msgId} in #${channel.name} (${guild.name})`);
                        console.log(`Content: ${message.content?.substring(0, 100) || 'No content'}`);
                        console.log(`Embeds: ${message.embeds.length}`);
                        console.log(`Attachments: ${message.attachments.size}`);
                        console.log(`Author: ${message.author.tag} (${message.author.id})`);
                        console.log(`Bot user: ${client.user.id}`);

                        // Check if it's our bot's message
                        if (message.author.id === client.user.id) {
                            // Get video info from existing embed
                            const existingEmbed = message.embeds[0];
                            if (existingEmbed) {
                                const title = existingEmbed.title || '';
                                const description = existingEmbed.description || '';
                                const username = title.replace(' uploaded a new TikTok!', '');

                                // Find TikTok URL from buttons or content
                                let tiktokUrl = '';
                                if (message.components.length > 0 && message.components[0].components.length > 0) {
                                    const button = message.components[0].components[0];
                                    if (button && button.url) {
                                        tiktokUrl = button.url;
                                    }
                                }
                                if (!tiktokUrl && message.content) {
                                    const match = message.content.match(/https:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/\d+/);
                                    if (match) tiktokUrl = match[0];
                                }

                                // Get thumbnail - try video thumbnail or use profile pic
                                let thumbnail = existingEmbed.thumbnail?.url || null;

                                // If we have an attachment (video), try to get thumbnail from TikTok
                                if (!thumbnail && message.attachments.size > 0) {
                                    // Could fetch from TikWM but for now we'll skip thumbnail
                                }

                                console.log(`Username: ${username}`);
                                console.log(`TikTok URL: ${tiktokUrl}`);
                                console.log(`Thumbnail: ${thumbnail || 'none'}`);

                                if (!tiktokUrl) {
                                    console.log('⚠️ No TikTok URL found, skipping...');
                                    continue;
                                }

                                // Create new FreshTok-style embed
                                const newEmbed = new EmbedBuilder()
                                    .setColor(0x5865F2) // Discord blurple
                                    .setTitle(`${username} uploaded a new TikTok!`)
                                    .setDescription(description)
                                    .setTimestamp(existingEmbed.timestamp ? new Date(existingEmbed.timestamp) : new Date());

                                if (thumbnail) {
                                    newEmbed.setThumbnail(thumbnail);
                                }

                                // Create new buttons
                                const viewButton = new ButtonBuilder()
                                    .setLabel('View on TikTok')
                                    .setStyle(ButtonStyle.Link)
                                    .setURL(tiktokUrl);

                                const analyticsButton = new ButtonBuilder()
                                    .setLabel('View Analytics')
                                    .setStyle(ButtonStyle.Link)
                                    .setURL(`https://certifriedmultitool.com/analytics/${username}`);

                                const row = new ActionRowBuilder().addComponents(viewButton, analyticsButton);

                                // Edit the message - keep files but update embed and buttons
                                await message.edit({
                                    embeds: [newEmbed],
                                    components: [row]
                                });

                                console.log(`✅ Updated message ${msgId}`);
                            }
                        } else {
                            console.log('⚠️ Message not from this bot, skipping...');
                        }
                    }
                } catch (err) {
                    // Message not in this channel, continue silently
                    if (err.code !== 10008) { // Unknown Message error is expected
                        // Only log unexpected errors
                    }
                }
            }
        }
    }

    console.log('\nDone searching all guilds!');
    process.exit(0);
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`In ${client.guilds.cache.size} guilds`);
    findAndEditMessages();
});

client.login(process.env.DISCORD_TOKEN);
