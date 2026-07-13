import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const LEVEL_GATE = 3;

export async function handleStreamSignupAdd(interaction) {
    try {
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;

        const [configRows] = await pool.execute(
            'SELECT stream_signup_channel_id, stream_announcement_channel_id, level_gate FROM stream_signup_config WHERE guild_id = ?',
            [guildId]
        );
        if (!configRows.length) {
            return interaction.reply({ content: 'Stream signup is not configured for this server.', ephemeral: true });
        }
        const gate = configRows[0].level_gate ?? LEVEL_GATE;

        const [levelRows] = await pool.execute(
            'SELECT level FROM user_levels WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );
        const currentLevel = levelRows.length ? levelRows[0].level : 0;
        if (currentLevel < gate) {
            return interaction.reply({
                content: `You need to reach **level ${gate}** before you can sign up for auto-shoutouts. You're currently level **${currentLevel}**. Chat around the server to earn XP!`,
                ephemeral: true,
            });
        }

        const modal = new ModalBuilder()
            .setCustomId('stream_signup_submit')
            .setTitle('Add your stream')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('platform')
                        .setLabel('Platform (twitch, kick, youtube, rumble…)')
                        .setPlaceholder('twitch')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(2).setMaxLength(32)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('username')
                        .setLabel('Your channel/username on that platform')
                        .setPlaceholder('your_channel_name')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(2).setMaxLength(64)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('api_key')
                        .setLabel('Rumble API key (ONLY if platform is rumble)')
                        .setPlaceholder('rumble.com/account/livestream-api — leave blank otherwise')
                        .setStyle(TextInputStyle.Short)
                        .setMaxLength(200)
                        .setRequired(false)
                ),
            );
        await interaction.showModal(modal);
    } catch (err) {
        logger.error('[stream_signup_add] error', { err: err.message, stack: err.stack });
        if (!interaction.replied) await interaction.reply({ content: 'Something went wrong. Try again.', ephemeral: true }).catch(() => {});
    }
}

export default handleStreamSignupAdd;
