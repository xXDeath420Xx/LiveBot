import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

let Canvas;
try {
    Canvas = await import('canvas');
} catch (e) {
    logger.warn('Canvas module not available. Test banner generation will be disabled.', { category: 'greeting' });
}

export async function handleSetWelcome(interaction) {
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: true });

    try {
        const channel = interaction.options.getChannel('channel');
        const message = interaction.options.getString('message');
        const bannerEnabled = interaction.options.getBoolean('enable-banner') || false;
        const background = interaction.options.getAttachment('background');

        let backgroundUrl = null;
        if (background) {
            if (!background.contentType?.startsWith('image/')) {
                await interaction.editReply('Background must be an image file (PNG, JPG, GIF).');
                return;
            }
            backgroundUrl = background.url;
        }

        await pool.execute(
            `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, banner_background_url)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               channel_id = VALUES(channel_id),
               message = VALUES(message),
               banner_enabled = VALUES(banner_enabled),
               banner_background_url = IF(VALUES(banner_background_url) IS NOT NULL, VALUES(banner_background_url), banner_background_url)`,
            [guildId, channel.id, message, bannerEnabled, backgroundUrl]
        );

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('Welcome Settings Updated')
            .setDescription(`Welcome messages will now be sent to ${channel}.`)
            .addFields(
                { name: 'Banner Enabled', value: bannerEnabled ? 'Yes' : 'No', inline: true },
                { name: 'Message', value: message, inline: false }
            )
            .setFooter({ text: 'Use {mention} to ping user, {user} for username, {server} for server name, {memberCount} for member count' });

        if (backgroundUrl) {
            embed.setImage(backgroundUrl);
        }

        await interaction.editReply({ embeds: [embed] });
        logger.info('Welcome settings updated', { guildId, category: 'greeting' });
    } catch (error) {
        logger.error('Error in welcome set-welcome', { guildId, error: error.message, stack: error.stack, category: 'greeting' });
        await interaction.editReply('An error occurred while processing your request. Please try again.');
    }
}

export async function handleSetGoodbye(interaction) {
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: true });

    try {
        const channel = interaction.options.getChannel('channel');
        const message = interaction.options.getString('message');

        await pool.execute(
            `INSERT INTO welcome_settings (guild_id, goodbye_enabled, goodbye_channel_id, goodbye_message)
             VALUES (?, TRUE, ?, ?)
             ON DUPLICATE KEY UPDATE
               goodbye_enabled = TRUE,
               goodbye_channel_id = VALUES(goodbye_channel_id),
               goodbye_message = VALUES(goodbye_message)`,
            [guildId, channel.id, message]
        );

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('Goodbye Settings Updated')
            .setDescription(`Goodbye messages will now be sent to ${channel}.`)
            .addFields({ name: 'Message', value: message, inline: false })
            .setFooter({ text: 'Use {user} for username, {server} for server name' });

        await interaction.editReply({ embeds: [embed] });
        logger.info('Goodbye settings updated', { guildId, category: 'greeting' });
    } catch (error) {
        logger.error('Error in welcome set-goodbye', { guildId, error: error.message, stack: error.stack, category: 'greeting' });
        await interaction.editReply('An error occurred while processing your request. Please try again.');
    }
}

export async function handleSetAutorole(interaction) {
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: true });

    try {
        const role = interaction.options.getRole('role');

        const botMember = interaction.guild.members.me;
        if (role.position >= botMember.roles.highest.position) {
            await interaction.editReply('I cannot assign this role as it is higher than or equal to my highest role.');
            return;
        }

        await pool.execute(
            `INSERT INTO welcome_settings (guild_id, auto_role_id)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE auto_role_id = VALUES(auto_role_id)`,
            [guildId, role.id]
        );

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('Auto Role Updated')
            .setDescription(`New members will automatically receive the ${role} role.`);

        await interaction.editReply({ embeds: [embed] });
        logger.info('Auto role updated', { guildId, roleId: role.id, category: 'greeting' });
    } catch (error) {
        logger.error('Error in welcome set-autorole', { guildId, error: error.message, stack: error.stack, category: 'greeting' });
        await interaction.editReply('An error occurred while processing your request. Please try again.');
    }
}

export async function handleDisable(interaction) {
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: true });

    try {
        const type = interaction.options.getString('type');

        switch (type) {
            case 'welcome':
                await pool.execute('UPDATE welcome_settings SET channel_id = NULL WHERE guild_id = ?', [guildId]);
                await interaction.editReply('Welcome messages have been disabled.');
                break;
            case 'goodbye':
                await pool.execute('UPDATE welcome_settings SET goodbye_enabled = FALSE WHERE guild_id = ?', [guildId]);
                await interaction.editReply('Goodbye messages have been disabled.');
                break;
            case 'autorole':
                await pool.execute('UPDATE welcome_settings SET auto_role_id = NULL WHERE guild_id = ?', [guildId]);
                await interaction.editReply('Auto role assignment has been disabled.');
                break;
            case 'banner':
                await pool.execute('UPDATE welcome_settings SET banner_enabled = FALSE WHERE guild_id = ?', [guildId]);
                await interaction.editReply('Welcome banner has been disabled.');
                break;
            case 'all':
                await pool.execute('DELETE FROM welcome_settings WHERE guild_id = ?', [guildId]);
                await interaction.editReply('All welcome and goodbye settings have been disabled.');
                break;
        }

        logger.info('Welcome/goodbye settings disabled', { guildId, type, category: 'greeting' });
    } catch (error) {
        logger.error('Error in welcome disable', { guildId, error: error.message, stack: error.stack, category: 'greeting' });
        await interaction.editReply('An error occurred while processing your request. Please try again.');
    }
}

export async function handleTest(interaction) {
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: true });

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM welcome_settings WHERE guild_id = ?',
            [guildId]
        );

        if (rows.length === 0 || !rows[0].channel_id) {
            await interaction.editReply('No welcome settings configured. Use `/manage welcome set-welcome` first.');
            return;
        }

        const config = rows[0];
        const member = interaction.member;

        let messageContent = config.message
            .replace(/{mention}/g, `<@${member.id}>`)
            .replace(/{user}/g, member.user.tag)
            .replace(/{server}/g, interaction.guild.name)
            .replace(/{memberCount}/g, interaction.guild.memberCount.toString());

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Welcome Message Preview')
            .setDescription(messageContent)
            .addFields(
                { name: 'Channel', value: `<#${config.channel_id}>`, inline: true },
                { name: 'Banner', value: config.banner_enabled ? 'Enabled' : 'Disabled', inline: true }
            );

        const files = [];

        if (config.banner_enabled && Canvas) {
            try {
                const width = 1024;
                const height = 450;
                const canvas = Canvas.createCanvas(width, height);
                const ctx = canvas.getContext('2d');

                if (config.banner_background_url) {
                    try {
                        const background = await Canvas.loadImage(config.banner_background_url);
                        ctx.drawImage(background, 0, 0, width, height);
                        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                        ctx.fillRect(0, 0, width, height);
                    } catch (e) {
                        logger.warn('Failed to load background for test banner', { category: 'greeting' });
                        const gradient = ctx.createLinearGradient(0, 0, width, height);
                        gradient.addColorStop(0, '#5865F2');
                        gradient.addColorStop(1, '#7289DA');
                        ctx.fillStyle = gradient;
                        ctx.fillRect(0, 0, width, height);
                    }
                } else {
                    const gradient = ctx.createLinearGradient(0, 0, width, height);
                    gradient.addColorStop(0, '#5865F2');
                    gradient.addColorStop(1, '#7289DA');
                    ctx.fillStyle = gradient;
                    ctx.fillRect(0, 0, width, height);
                }

                const avatarSize = 200;
                const avatarX = width / 2 - avatarSize / 2;
                const avatarY = 80;

                try {
                    const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
                    const avatar = await Canvas.loadImage(avatarUrl);

                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true);
                    ctx.closePath();
                    ctx.clip();
                    ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
                    ctx.restore();

                    ctx.strokeStyle = '#FFFFFF';
                    ctx.lineWidth = 6;
                    ctx.beginPath();
                    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true);
                    ctx.closePath();
                    ctx.stroke();
                } catch (err) {
                    logger.warn('Failed to load avatar for test banner', { category: 'greeting' });
                }

                ctx.textAlign = 'center';
                ctx.fillStyle = '#FFFFFF';
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 4;

                ctx.font = 'bold 56px Arial';
                ctx.strokeText('WELCOME', width / 2, 320);
                ctx.fillText('WELCOME', width / 2, 320);

                ctx.font = 'bold 42px Arial';
                const username = member.user.username;
                const truncatedUsername = username.length > 20 ? username.substring(0, 20) + '...' : username;
                ctx.strokeText(truncatedUsername, width / 2, 380);
                ctx.fillText(truncatedUsername, width / 2, 380);

                ctx.font = '32px Arial';
                const memberText = `Member #${interaction.guild.memberCount}`;
                ctx.strokeText(memberText, width / 2, 420);
                ctx.fillText(memberText, width / 2, 420);

                const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'welcome-preview.png' });
                files.push(attachment);
            } catch (error) {
                logger.error('Failed to generate test banner', { error: error.message, category: 'greeting' });
                embed.addFields({ name: 'Banner Error', value: 'Failed to generate preview banner', inline: false });
            }
        }

        await interaction.editReply({ embeds: [embed], files });
        logger.info('Welcome test generated', { guildId, category: 'greeting' });
    } catch (error) {
        logger.error('Error in welcome test', { guildId, error: error.message, stack: error.stack, category: 'greeting' });
        await interaction.editReply('An error occurred while processing your request. Please try again.');
    }
}
