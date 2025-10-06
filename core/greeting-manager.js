const { AttachmentBuilder } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');
const { createCanvas, loadImage, registerFont } = require('canvas');

// Register font
try {
    registerFont('./fonts/Inter-Bold.ttf', { family: 'InterBold' });
} catch (e) {
    logger.warn('[GreetingManager] Could not load custom font. Falling back to sans-serif.');
}


async function generateWelcomeCard(member, settings) {
    // ... (This entire function remains the same as before)
    const canvas = createCanvas(700, 250);
    const ctx = canvas.getContext('2d');
    try {
        const background = await loadImage(settings.card_background_url || 'https://i.imgur.com/gGkExuB.png');
        ctx.drawImage(background, 0, 0, canvas.width, canvas.height);
    } catch {
        ctx.fillStyle = '#2b2d31';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '36px InterBold, sans-serif';
    ctx.fillStyle = settings.card_title_color || '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(settings.card_title_text || 'WELCOME', canvas.width / 2, 60);
    ctx.font = '30px InterBold, sans-serif';
    ctx.fillStyle = settings.card_username_color || '#FFFFFF';
    ctx.fillText(member.user.username.substring(0, 20), canvas.width / 2, 180);
    const subtitle = (settings.card_subtitle_text || 'Welcome to the server!').replace(/{server.count}/g, member.guild.memberCount);
    ctx.font = '22px InterBold, sans-serif';
    ctx.fillStyle = settings.card_subtitle_color || '#FFFFFF';
    ctx.fillText(subtitle, canvas.width / 2, 215);
    ctx.beginPath();
    ctx.arc(canvas.width / 2, 115, 50, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    const avatar = await loadImage(member.user.displayAvatarURL({ extension: 'png' }));
    ctx.drawImage(avatar, (canvas.width / 2) - 50, 65, 100, 100);
    ctx.restore();
    return new AttachmentBuilder(canvas.toBuffer(), { name: 'welcome-card.png' });
}

async function handleGuildMemberAdd(member) {
    try {
        const [[settings]] = await db.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [member.guild.id]);
        if (!settings || !settings.channel_id) return;

        const welcomeChannel = await member.guild.channels.fetch(settings.channel_id).catch(() => null);
        if (!welcomeChannel) return;

        const welcomeMessage = (settings.message || 'Welcome {user}!').replace(/{user}/g, member.toString()).replace(/{server}/g, member.guild.name);
        const files = [];
        if (settings.card_enabled) {
            const attachment = await generateWelcomeCard(member, settings);
            files.push(attachment);
        }
        await welcomeChannel.send({ content: welcomeMessage, files: files });
    } catch (error) {
        logger.error(`[GreetingManager] Failed to send welcome message for ${member.user.tag}:`, error);
    }
}

async function handleGuildMemberRemove(member) {
    try {
        const [[settings]] = await db.execute('SELECT goodbye_enabled, goodbye_channel_id, goodbye_message FROM welcome_settings WHERE guild_id = ?', [member.guild.id]);
        if (!settings || !settings.goodbye_enabled || !settings.goodbye_channel_id) return;

        const goodbyeChannel = await member.guild.channels.fetch(settings.goodbye_channel_id).catch(() => null);
        if (!goodbyeChannel) return;

        const goodbyeMessage = (settings.goodbye_message || '{user.tag} has left the server.')
            .replace(/{user.tag}/g, member.user.tag)
            .replace(/{user.name}/g, member.user.username)
            .replace(/{server.name}/g, member.guild.name)
            .replace(/{server.count}/g, member.guild.memberCount);

        await goodbyeChannel.send(goodbyeMessage);
    } catch (error) {
        logger.error(`[GreetingManager] Failed to send goodbye message for ${member.user.tag}:`, error);
    }
}

module.exports = { handleGuildMemberAdd, handleGuildMemberRemove };