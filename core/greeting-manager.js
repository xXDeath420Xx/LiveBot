const { AttachmentBuilder } = require('discord.js');
const db = require('../utils/db');
const Canvas = require('canvas');
const path = require('path');
const logger = require('../utils/logger');

// Register a default font
try {
    const fontPath = path.join(__dirname, '..', 'assets', 'fonts', 'sans-serif.ttf'); // A default font
    Canvas.registerFont(fontPath, { family: 'DefaultFont' });
} catch (e) {
    logger.warn('Could not load default font. System fonts will be used.', { category: 'greeting' });
}

async function handleGuildMemberAdd(member) {
    const guildId = member.guild.id;
    try {
        const [settings] = await db.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [guildId]);
        if (settings.length === 0 || !settings[0].channel_id) return;

        const config = settings[0];
        const channel = member.guild.channels.cache.get(config.channel_id);
        if (!channel) return;

        let messageContent = config.message
            .replace(/{user}/g, member.user.tag)
            .replace(/{server}/g, member.guild.name)
            .replace(/{memberCount}/g, member.guild.memberCount);

        if (config.banner_enabled) {
            const canvas = Canvas.createCanvas(700, 250);
            const ctx = canvas.getContext('2d');

            // Background
            try {
                const background = await Canvas.loadImage(config.banner_background_url || path.join(__dirname, '..', 'assets', 'images', 'default-welcome-bg.png'));
                ctx.drawImage(background, 0, 0, canvas.width, canvas.height);
            } catch (e) {
                logger.error('Failed to load welcome card background.', { guildId, category: 'greeting', error: e.stack });
                ctx.fillStyle = '#23272A';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            // Title
            ctx.font = '30px "DefaultFont", sans-serif';
            ctx.fillStyle = config.card_title_color || '#ffffff';
            ctx.fillText(config.card_title_text.replace(/{user}/g, member.user.tag), canvas.width / 2.5, canvas.height / 2.5);

            // Subtitle
            ctx.font = '20px "DefaultFont", sans-serif';
            ctx.fillStyle = config.card_subtitle_color || '#ffffff';
            ctx.fillText(config.card_subtitle_text.replace(/{server}/g, member.guild.name), canvas.width / 2.5, canvas.height / 1.8);

            // Username
            ctx.font = 'bold 25px "DefaultFont", sans-serif';
            ctx.fillStyle = config.card_username_color || '#ffffff';
            ctx.fillText(member.displayName, canvas.width / 2.5, canvas.height / 1.3);

            // Avatar
            ctx.beginPath();
            ctx.arc(125, 125, 100, 0, Math.PI * 2, true);
            ctx.closePath();
            ctx.clip();
            const avatar = await Canvas.loadImage(member.user.displayAvatarURL({ extension: 'jpg' }));
            ctx.drawImage(avatar, 25, 25, 200, 200);

            const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'welcome-image.png' });
            await channel.send({ content: messageContent, files: [attachment] });
            logger.info(`Sent welcome card for ${member.user.tag}.`, { guildId, category: 'greeting' });

        } else {
            await channel.send(messageContent);
            logger.info(`Sent welcome message for ${member.user.tag}.`, { guildId, category: 'greeting' });
        }
    } catch (error) {
        logger.error('Error handling guild member add.', { guildId, category: 'greeting', error: error.stack });
    }
}

async function handleGuildMemberRemove(member) {
    const guildId = member.guild.id;
    try {
        const [settings] = await db.execute('SELECT goodbye_enabled, goodbye_channel_id, goodbye_message FROM welcome_settings WHERE guild_id = ?', [guildId]);
        if (settings.length === 0 || !settings[0].goodbye_enabled || !settings[0].goodbye_channel_id) return;

        const config = settings[0];
        const channel = member.guild.channels.cache.get(config.goodbye_channel_id);
        if (!channel) return;

        let messageContent = config.goodbye_message
            .replace(/{user}/g, member.user.tag)
            .replace(/{server}/g, member.guild.name);

        await channel.send(messageContent);
        logger.info(`Sent goodbye message for ${member.user.tag}.`, { guildId, category: 'greeting' });
    } catch (error) {
        logger.error('Error handling guild member remove.', { guildId, category: 'greeting', error: error.stack });
    }
}

module.exports = { handleGuildMemberAdd, handleGuildMemberRemove };