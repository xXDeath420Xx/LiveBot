import { createCanvas, loadImage, registerFont, Canvas, Image } from 'canvas';
import logger from '../utils/logger';
import { GuildMember } from 'discord.js';

/**
 * Generates a welcome banner image for a new member
 * @param member - The Discord guild member
 * @param backgroundUrl - Optional custom background image URL
 * @returns PNG image buffer
 */
async function generateWelcomeBanner(member: GuildMember, backgroundUrl: string | null = null): Promise<Buffer> {
    try {
        // Canvas dimensions
        const width = 1024;
        const height = 450;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // Background
        if (backgroundUrl) {
            try {
                const background = await loadImage(backgroundUrl);
                // Draw background, scale to cover entire canvas
                ctx.drawImage(background, 0, 0, width, height);
                // Add semi-transparent overlay for better text visibility
                ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                ctx.fillRect(0, 0, width, height);
            } catch (err: any) {
                logger.warn(`[Welcome Banner] Failed to load background image: ${err.message}. Using default gradient.`);
                // Fallback to gradient background
                const gradient = ctx.createLinearGradient(0, 0, width, height);
                gradient.addColorStop(0, '#5865F2');
                gradient.addColorStop(1, '#7289DA');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, width, height);
            }
        } else {
            // Default gradient background
            const gradient = ctx.createLinearGradient(0, 0, width, height);
            gradient.addColorStop(0, '#5865F2');
            gradient.addColorStop(1, '#7289DA');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, height);
        }

        // Load user avatar
        const avatarSize = 200;
        const avatarX = width / 2 - avatarSize / 2;
        const avatarY = 80;

        try {
            const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
            const avatar = await loadImage(avatarUrl);

            // Draw circular avatar
            ctx.save();
            ctx.beginPath();
            ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
            ctx.restore();

            // Draw avatar border
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true);
            ctx.closePath();
            ctx.stroke();
        } catch (err: any) {
            logger.error(`[Welcome Banner] Failed to load avatar for ${member.user.tag}: ${err.message}`);
        }

        // Text setup
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 4;

        // Welcome text
        ctx.font = 'bold 56px Arial';
        ctx.strokeText('WELCOME', width / 2, 320);
        ctx.fillText('WELCOME', width / 2, 320);

        // Username
        ctx.font = 'bold 42px Arial';
        const username = member.user.username;
        const truncatedUsername = username.length > 20 ? username.substring(0, 20) + '...' : username;
        ctx.strokeText(truncatedUsername, width / 2, 380);
        ctx.fillText(truncatedUsername, width / 2, 380);

        // Member count
        ctx.font = '32px Arial';
        const memberCount = member.guild.memberCount;
        const memberText = `Member #${memberCount}`;
        ctx.strokeText(memberText, width / 2, 420);
        ctx.fillText(memberText, width / 2, 420);

        return canvas.toBuffer('image/png');
    } catch (error: any) {
        logger.error('[Welcome Banner] Failed to generate banner:', error as Record<string, any>);
        throw error;
    }
}

export { generateWelcomeBanner };
