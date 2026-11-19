import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { renderWelcomePost } from '../../core/greeting-manager.js';
import { checkBackground, storeWelcomeBackground } from '../../core/welcome-background.js';
import { discardReplacedUpload } from '../../core/server-image-uploads.js';

export async function handleSetWelcome(interaction) {
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: true });

    try {
        const channel = interaction.options.getChannel('channel');
        const message = interaction.options.getString('message');
        // Left out = keep what is saved (the dashboard's choice, say), not "off".
        const bannerChoice = interaction.options.getBoolean('enable-banner');
        const background = interaction.options.getAttachment('background');

        // Saved like a dashboard upload, not as the Discord attachment link, which expires.
        let backgroundUrl = null;
        if (background) {
            const check = checkBackground(background);
            if (!check.ok) {
                await interaction.editReply(check.error);
                return;
            }
            try {
                backgroundUrl = (await storeWelcomeBackground(guildId, background)).url;
            } catch (err) {
                logger.warn('Welcome background upload failed', { guildId, error: err.message, category: 'greeting' });
                await interaction.editReply(`The background could not be saved: ${err.message} Nothing was changed.`);
                return;
            }
        }

        // H-706: the banner a new background replaces; its uploaded file is deleted after the save.
        const [[prevWelcome]] = backgroundUrl
            ? await pool.execute('SELECT card_background_url FROM welcome_settings WHERE guild_id = ?', [guildId])
            : [[null]];

        await pool.execute(
            `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, card_background_url)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               channel_id = VALUES(channel_id),
               message = VALUES(message),
               banner_enabled = IF(?, banner_enabled, VALUES(banner_enabled)),
               card_background_url = IF(VALUES(card_background_url) IS NOT NULL, VALUES(card_background_url), card_background_url)`,
            [guildId, channel.id, message, bannerChoice ? 1 : 0, backgroundUrl, bannerChoice === null ? 1 : 0]
        );
        if (prevWelcome?.card_background_url) await discardReplacedUpload(prevWelcome.card_background_url, backgroundUrl);

        const [[saved]] = await pool.execute('SELECT banner_enabled FROM welcome_settings WHERE guild_id = ?', [guildId]);
        const bannerOn = Boolean(Number(saved?.banner_enabled));

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle('Welcome Settings Updated')
            .setDescription(`Welcome messages will now be sent to ${channel}.`)
            .addFields(
                { name: 'Banner Enabled', value: bannerOn ? 'Yes' : 'No', inline: true },
                { name: 'Message', value: message, inline: false }
            )
            .setFooter({ text: 'Use {mention} to ping user, {user} for username, {server} for server name, {memberCount} for member count. /manage welcome test shows the post.' });

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
            .setColor(themeColor(interaction.guildId, 'success'))
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
            .setColor(themeColor(interaction.guildId, 'success'))
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

        // The same post a new member gets (core/greeting-manager.js), drawn for the person asking:
        // message style, text, and with the banner on the card with this server's background,
        // title, subtitle and light or dark style.
        const { payload } = await renderWelcomePost(interaction.member, config, { preview: true });
        const head = `Preview of the welcome post for <#${config.channel_id}>. Only you can see this.`;
        const body = payload.content ? `${head}

${payload.content}` : head;
        await interaction.editReply({
            content: body.length > 2000 ? `${body.slice(0, 1999)}…` : body,
            embeds: payload.embeds || [],
            files: payload.files || [],
            allowedMentions: { parse: [] },
        });
        logger.info('Welcome test generated', { guildId, category: 'greeting' });
    } catch (error) {
        logger.error('Error in welcome test', { guildId, error: error.message, stack: error.stack, category: 'greeting' });
        await interaction.editReply('An error occurred while processing your request. Please try again.');
    }
}
