import { SlashCommandBuilder, PermissionsBitField, ChannelType } from 'discord.js';
import { addShowcaseChannel, removeShowcaseChannel, listShowcaseChannels } from '../../core/showcase-manager.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('showcase')
        .setDescription('Manage Creator Showcase channels (uploads become protected, no-download streams)')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Make a channel a Creator Showcase (audio/video uploads are re-hosted as protected streams)')
                .addChannelOption(opt =>
                    opt.setName('channel').setDescription('The channel to enable (defaults to current)')
                        .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Stop treating a channel as a Creator Showcase')
                .addChannelOption(opt =>
                    opt.setName('channel').setDescription('The channel to disable (defaults to current)')
                        .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub =>
            sub.setName('list').setDescription('List the Creator Showcase channels in this server')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'add') {
                await interaction.deferReply({ ephemeral: true });
                const channel = interaction.options.getChannel('channel') || interaction.channel;
                await addShowcaseChannel(interaction.guildId, channel.id, interaction.user.id);
                return interaction.editReply(
                    `✅ <#${channel.id}> is now a **Creator Showcase**.\n` +
                    `When someone uploads audio/video there, I'll delete the original file and re-post it as a ` +
                    `**watermarked, download-disabled stream** on the dashboard.\n` +
                    `_Note: anything playable can still be screen/stream-captured — this stops casual downloading, not determined ripping._`
                );
            }
            if (sub === 'remove') {
                await interaction.deferReply({ ephemeral: true });
                const channel = interaction.options.getChannel('channel') || interaction.channel;
                await removeShowcaseChannel(channel.id);
                return interaction.editReply(`Removed <#${channel.id}> from the Creator Showcase list. New uploads there won't be processed.`);
            }
            if (sub === 'list') {
                await interaction.deferReply({ ephemeral: true });
                const ids = await listShowcaseChannels(interaction.guildId);
                return interaction.editReply(ids.length
                    ? `**Creator Showcase channels:**\n${ids.map(id => `• <#${id}>`).join('\n')}`
                    : 'No Creator Showcase channels set. Use `/showcase add` to create one.');
            }
        } catch (err) {
            logger.error('[Showcase command] error', { error: err.message, sub });
            const msg = 'Something went wrong — try again or check the logs.';
            if (interaction.deferred) return interaction.editReply(msg);
            return interaction.reply({ content: msg, ephemeral: true });
        }
    },
};
