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
                .setDescription('Post the orientation message, or refresh the existing one')
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Channel to post in (defaults to current)')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                )
                .addBooleanOption(opt =>
                    opt.setName('fresh')
                        .setDescription('Delete the old message and post a new one at the bottom of the channel')
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
                    const fresh = interaction.options.getBoolean('fresh') ?? false;
                    const result = await postOrientationMessage(interaction.client, interaction.guildId, channel.id, { fresh });

                    if (!result) {
                        await interaction.editReply('Failed to post the orientation message. Make sure I can see and send messages in that channel.');
                        break;
                    }

                    // The default path edits the existing message in place, which
                    // leaves it wherever it was first posted — possibly months up
                    // the channel. Saying "posted!" there reads as a silent
                    // failure, so say what actually happened and link to it.
                    if (result.action === 'edited') {
                        const posted = Math.floor(result.message.createdTimestamp / 1000);
                        await interaction.editReply(
                            `Refreshed the orientation message that's already in <#${result.message.channelId}> ` +
                            `(originally posted <t:${posted}:R>) — it now shows this server's current features:\n${result.message.url}\n\n` +
                            `Nothing new appeared at the bottom of the channel because it was updated in place. ` +
                            `To delete it and post a new one at the bottom instead, run \`/systems orientation post fresh: True\`.`
                        );
                    } else {
                        await interaction.editReply(`Orientation message posted in <#${channel.id}>:\n${result.message.url}`);
                    }
                    break;
                }

                case 'update': {
                    await interaction.deferReply({ ephemeral: true });
                    const updated = await updateOrientationMessage(interaction.client, interaction.guildId);

                    if (updated) {
                        await interaction.editReply('Orientation message updated with current feature state.');
                    } else {
                        await interaction.editReply('No existing orientation message found. Use `/systems orientation post` first.');
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
