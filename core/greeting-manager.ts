import { AttachmentBuilder, GuildMember, TextChannel } from 'discord.js';
import db from '../utils/db';
import * as Canvas from 'canvas';
import * as path from 'path';
import logger from '../utils/logger';
import { RowDataPacket } from 'mysql2';

interface WelcomeSettings extends RowDataPacket {
    channel_id: string;
    message: string;
    banner_enabled: boolean;
    banner_background_url: string | null;
    goodbye_enabled: boolean;
    goodbye_channel_id: string | null;
    goodbye_message: string | null;
}

// Register a default font
try {
    const fontPath = path.join(__dirname, '..', 'assets', 'fonts', 'sans-serif.ttf'); // A default font
    Canvas.registerFont(fontPath, { family: 'DefaultFont' });
} catch (e) {
    logger.warn('Could not load default font. System fonts will be used.', { category: 'greeting' });
}

async function handleGuildMemberAdd(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;
    try {
        const [settings] = await db.execute<WelcomeSettings[]>('SELECT * FROM welcome_settings WHERE guild_id = ?', [guildId]);
        if (settings.length === 0 || !settings[0].channel_id) return;

        const config = settings[0];
        const channel = member.guild.channels.cache.get(config.channel_id) as TextChannel | undefined;
        if (!channel) return;

        let messageContent = config.message
            .replace(/{user}/g, member.user.tag)
            .replace(/{server}/g, member.guild.name)
            .replace(/{memberCount}/g, member.guild.memberCount.toString());

        if (config.banner_enabled) {
            // Enhanced banner design with better quality
            const width = 1024;
            const height = 450;
            const canvas = Canvas.createCanvas(width, height);
            const ctx = canvas.getContext('2d');

            // Background
            try {
                if (config.banner_background_url) {
                    const background = await Canvas.loadImage(config.banner_background_url);
                    // Draw background, scale to cover entire canvas
                    ctx.drawImage(background, 0, 0, width, height);
                    // Add semi-transparent overlay for better text visibility
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                    ctx.fillRect(0, 0, width, height);
                } else {
                    // Default gradient background
                    const gradient = ctx.createLinearGradient(0, 0, width, height);
                    gradient.addColorStop(0, '#5865F2');
                    gradient.addColorStop(1, '#7289DA');
                    ctx.fillStyle = gradient;
                    ctx.fillRect(0, 0, width, height);
                }
            } catch (e: any) {
                logger.error('Failed to load welcome card background.', { guildId, category: 'greeting', error: e.stack });
                // Fallback to gradient
                const gradient = ctx.createLinearGradient(0, 0, width, height);
                gradient.addColorStop(0, '#5865F2');
                gradient.addColorStop(1, '#7289DA');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, width, height);
            }

            // Load and draw circular avatar with border
            const avatarSize = 200;
            const avatarX = width / 2 - avatarSize / 2;
            const avatarY = 80;

            try {
                const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
                const avatar = await Canvas.loadImage(avatarUrl);

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
                logger.error(`Failed to load avatar for ${member.user.tag}:`, { error: err.message, category: 'greeting' });
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

            const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'welcome-image.png' });
            await channel.send({ content: messageContent, files: [attachment] });
            logger.info(`Sent enhanced welcome banner for ${member.user.tag}.`, { guildId, category: 'greeting' });

        } else {
            await channel.send(messageContent);
            logger.info(`Sent welcome message for ${member.user.tag}.`, { guildId, category: 'greeting' });
        }
    } catch (error: any) {
        logger.error('Error handling guild member add.', { guildId, category: 'greeting', error: error.stack });
    }
}

async function handleGuildMemberRemove(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;
    try {
        const [settings] = await db.execute<WelcomeSettings[]>('SELECT goodbye_enabled, goodbye_channel_id, goodbye_message FROM welcome_settings WHERE guild_id = ?', [guildId]);
        if (settings.length === 0 || !settings[0].goodbye_enabled || !settings[0].goodbye_channel_id) return;

        const config = settings[0];
        const channel = member.guild.channels.cache.get(config.goodbye_channel_id) as TextChannel | undefined;
        if (!channel) return;

        let messageContent = (config.goodbye_message || '')
            .replace(/{user}/g, member.user.tag)
            .replace(/{server}/g, member.guild.name);

        await channel.send(messageContent);
        logger.info(`Sent goodbye message for ${member.user.tag}.`, { guildId, category: 'greeting' });
    } catch (error: any) {
        logger.error('Error handling guild member remove.', { guildId, category: 'greeting', error: error.stack });
    }
}

export { handleGuildMemberAdd, handleGuildMemberRemove };
