import { SlashCommandBuilder, PermissionsBitField, ChannelType } from 'discord.js';
import {
    postOrientationMessage,
    updateOrientationMessage,
    removeOrientationMessage
} from '../../core/orientation-manager.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('orientation')
        .setDescription('Manage the server orientation/guide message')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addSubcommand(sub =>
            sub.setName('post')
                .setDescription('Post or re-post the orientation message')
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Channel to post in (defaults to current)')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                )
        )
        .addSubcommand(sub =>
            sub.setName('update')
                .setDescription('Update the existing orientation message with current feature state')
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Delete the orientation message and clear the config')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        try {
            switch (sub) {
                case 'post': {
                    await interaction.deferReply({ ephemeral: true });
                    const channel = interaction.options.getChannel('channel') || interaction.channel;
                    const msg = await postOrientationMessage(interaction.client, interaction.guildId, channel.id);

                    if (msg) {
                        await interaction.editReply(`Orientation message posted in <#${channel.id}>!`);
                    } else {
                        await interaction.editReply('Failed to post the orientation message. Make sure I can send messages in that channel.');
                    }
                    break;
                }

                case 'update': {
                    await interaction.deferReply({ ephemeral: true });
                    const updated = await updateOrientationMessage(interaction.client, interaction.guildId);

                    if (updated) {
                        await interaction.editReply('Orientation message updated with current feature state.');
                    } else {
                        await interaction.editReply('No existing orientation message found. Use `/orientation post` first.');
                    }
                    break;
                }

                case 'remove': {
                    await interaction.deferReply({ ephemeral: true });
                    await removeOrientationMessage(interaction.client, interaction.guildId);
                    await interaction.editReply('Orientation message removed and config cleared.');
                    break;
                }
            }
        } catch (error) {
            logger.error('[Orientation Command] Error:', { error: error.message, sub, stack: error.stack });
            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};
