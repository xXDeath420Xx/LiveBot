// utils/announcer.js

const { EmbedBuilder } = require('discord.js');

const platformPriority = ['twitch', 'youtube', 'kick', 'tiktok', 'trovo'];

// Correct platform colors map
const platformColors = {
    twitch: '#9146FF',
    youtube: '#FF0000',
    kick: '#52E252',
    tiktok: '#00f2ea',
    trovo: '#21d464',
    default: '#00FF00'
};

async function updateAnnouncement(client, livePlatforms, existingAnnouncement) {
    if (livePlatforms.length === 0) return null;

    livePlatforms.sort((a, b) => platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform));
    const primaryPlatform = livePlatforms[0];
    const { liveData } = primaryPlatform;

    const username = liveData.username || 'Streamer';
    const platformName = primaryPlatform.platform.charAt(0).toUpperCase() + primaryPlatform.platform.slice(1);
    const title = liveData.title || `Live on ${platformName}!`;
    const game = liveData.game || 'Just Chatting';
    const url = liveData.url || '';
    const thumbnailUrl = liveData.thumbnailUrl || '';

    // Dynamically set color based on the primary platform
    const embedColor = platformColors[primaryPlatform.platform] || platformColors.default;

    const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setAuthor({ name: `${username} is now live on ${platformName}!`, url: url })
        .setTitle(title)
        .setURL(url)
        .addFields({ name: 'Playing', value: game, inline: true })
        .setTimestamp();
    
    if (thumbnailUrl && thumbnailUrl.startsWith('http')) {
        embed.setImage(thumbnailUrl);
    }

    if (livePlatforms.length > 1) {
        const otherPlatforms = livePlatforms.slice(1)
            .map(p => `• [${p.platform.charAt(0).toUpperCase() + p.platform.slice(1)}](${p.liveData.url})`)
            .join('\n');
        embed.addFields({ name: 'Also Live On', value: otherPlatforms, inline: true });
    }
    
    const messageContent = primaryPlatform.custom_message 
        ? primaryPlatform.custom_message
            .replace(/{username}/g, username)
            .replace(/{platform}/g, platformName)
            .replace(/{url}/g, url)
            .replace(/{title}/g, title)
            .replace(/{game}/g, game)
        : '';

    try {
        const channel = await client.channels.fetch(primaryPlatform.announcement_channel_id);
        if (!channel) return null;

        if (existingAnnouncement?.message_id) {
            try {
                const existingMessage = await channel.messages.fetch(existingAnnouncement.message_id);
                return await existingMessage.edit({ content: messageContent, embeds: [embed] });
            } catch (error) {
                console.log(`[Announcer] Could not edit message ${existingAnnouncement.message_id}, sending a new one.`);
                return await channel.send({ content: messageContent, embeds: [embed] });
            }
        } else {
            return await channel.send({ content: messageContent, embeds: [embed] });
        }
    } catch (error) {
        console.error(`[Announcer] A critical error occurred while sending announcement for ${username}:`, error);
        return null;
    }
}

module.exports = {
    updateAnnouncement,
    platformPriority
};