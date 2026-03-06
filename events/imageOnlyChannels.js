/**
 * Image-Only Channel Enforcer
 * Deletes messages without images in designated showcase channels
 */

import logger from '../utils/logger.js';

// Channel name keywords that should be image-only
const IMAGE_ONLY_KEYWORDS = [
    'plant-pics',
    'harvest-gallery',
    'setup-showcase'
];

// Allowed image/video types
const ALLOWED_MEDIA_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/quicktime'
];

export default {
    name: 'messageCreate',
    async execute(message) {
        // Ignore bots, DMs, and system messages
        if (message.author.bot || !message.guild || message.system) return;

        // Check if this is an image-only channel
        const channelName = message.channel.name?.toLowerCase() || '';
        const isImageOnly = IMAGE_ONLY_KEYWORDS.some(keyword => channelName.includes(keyword));

        if (!isImageOnly) return;

        // Check if message has valid media
        const hasMedia = message.attachments.some(a =>
            ALLOWED_MEDIA_TYPES.some(type => a.contentType?.startsWith(type.split('/')[0]))
        );

        // Also check for embeds with images (e.g., Discord image links)
        const hasEmbedImage = message.embeds.some(e => e.image || e.thumbnail);

        if (hasMedia || hasEmbedImage) return;

        // Allow staff/mods to post text
        const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member) {
            const isStaff = member.permissions.has('ManageMessages') ||
                member.roles.cache.some(r =>
                    r.name.toLowerCase().includes('mod') ||
                    r.name.toLowerCase().includes('admin') ||
                    r.name.toLowerCase().includes('staff')
                );
            if (isStaff) return;
        }

        // Delete the message
        try {
            await message.delete();

            // Send temporary warning
            const warning = await message.channel.send({
                content: `📸 ${message.author}, this channel is for images/videos only! Please include a photo with your post.`
            });

            // Delete warning after 8 seconds
            setTimeout(() => warning.delete().catch(() => {}), 8000);

            logger.info(`[ImageOnly] Deleted non-image message`, {
                guildId: message.guild.id,
                channelId: message.channel.id,
                userId: message.author.id
            });

        } catch (error) {
            logger.debug(`[ImageOnly] Could not delete message: ${error.message}`);
        }
    }
};
