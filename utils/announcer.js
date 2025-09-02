const { EmbedBuilder } = require('discord.js');

// --- START: MISSING DECLARATIONS (THE FIX) ---
// These two constants were accidentally removed in the last update.
const platformPriority = ['twitch', 'youtube', 'kick', 'tiktok', 'trovo'];
const platformColors = {
    twitch: '#9146FF',
    youtube: '#FF0000',
    kick: '#52E252',
    tiktok: '#00f2ea',
    trovo: '#21d464',
    default: '#36393f'
};
// --- END: MISSING DECLARATIONS (THE FIX) ---

async function updateAnnouncement(client, livePlatforms, existingAnnouncement) {
    if (livePlatforms.length === 0) return null;
    
    // This line will now work because platformPriority is defined above
    livePlatforms.sort((a, b) => platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform));
    
    const primaryPlatform = livePlatforms[0];
    
    console.log(`[Announcer] Preparing announcement for ${primaryPlatform.liveData.username || primaryPlatform.username} on ${primaryPlatform.platform} in guild ${primaryPlatform.guild_id}.`);

    const { liveData, custom_message, announcement_channel_id } = primaryPlatform;
    const platformName = primaryPlatform.platform.charAt(0).toUpperCase() + primaryPlatform.platform.slice(1);
    const username = liveData.username || primaryPlatform.username;
    const title = liveData.title || `Live on ${platformName}!`;
    const game = liveData.game || 'N/A';
    const url = liveData.url || '';
    const thumbnailUrl = liveData.thumbnailUrl ? `${liveData.thumbnailUrl}?t=${Date.now()}` : null;
    
    const embed = new EmbedBuilder()
        .setColor(platformColors[primaryPlatform.platform] || platformColors.default)
        .setAuthor({ name: `${username} is LIVE on ${platformName}!`, url: url, iconURL: client.guilds.cache.get(primaryPlatform.guild_id)?.iconURL() })
        .setTitle(title)
        .setURL(url)
        .addFields({ name: 'Playing', value: game, inline: true })
        .setTimestamp();
    
    if (thumbnailUrl) embed.setImage(thumbnailUrl);

    if (livePlatforms.length > 1) {
        const otherPlatforms = livePlatforms.slice(1)
            .map(p => `• [${p.platform.charAt(0).toUpperCase() + p.platform.slice(1)}](${p.liveData.url})`)
            .join('\n');
        embed.addFields({ name: 'Also Live On', value: otherPlatforms, inline: true });
    }
    
    const messageContent = custom_message
        ? custom_message.replace(/{username}/g, username).replace(/{platform}/g, platformName).replace(/{url}/g, url).replace(/{title}/g, title).replace(/{game}/g, game)
        : null;

    try {
        const channel = await client.channels.fetch(announcement_channel_id);
        if (!channel?.isTextBased()) {
            console.error(`[Announcer] Failed: Channel ${announcement_channel_id} not found or is not a text channel.`);
            return null;
        }

        if (existingAnnouncement?.message_id) {
            console.log(`[Announcer] Attempting to EDIT existing message: ${existingAnnouncement.message_id}`);
            const existingMessage = await channel.messages.fetch(existingAnnouncement.message_id);
            return await existingMessage.edit({ content: messageContent, embeds: [embed] });
        } else {
            console.log(`[Announcer] No existing message found. Sending NEW announcement.`);
            return await channel.send({ content: messageContent, embeds: [embed] });
        }
    } catch (error) {
        console.error(`[Announcer] Failed to send/edit announcement for ${username}: ${error.message}`);
        // If the old message was deleted, try sending a new one.
        if (error.code === 10008 && !existingAnnouncement) {
             console.log('[Announcer] Original message was deleted, sending a new one.');
             const channel = await client.channels.fetch(announcement_channel_id).catch(() => null);
             if (channel) return await channel.send({ content: messageContent, embeds: [embed] });
        }
        return null;
    }
}

module.exports = {
    updateAnnouncement,
    platformPriority // Now correctly exported after being defined
};