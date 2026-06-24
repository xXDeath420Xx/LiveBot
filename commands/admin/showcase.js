import {
    SlashCommandBuilder, PermissionsBitField, ChannelType,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import {
    addShowcaseChannel, removeShowcaseChannel, listShowcaseChannels, handleShowcaseUploadCommand,
} from '../../core/showcase-manager.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('showcase')
        .setDescription('Creator Showcase — share music/video as protected, no-download streams')
        // No command-level permission gate: `upload` is open to everyone; add/remove/list
        // are admin-checked in the handler.
        .addSubcommand(sub =>
            sub.setName('upload')
                .setDescription('Privately upload your audio/video to this showcase channel (file is never posted publicly)')
                .addAttachmentOption(opt =>
                    opt.setName('file').setDescription('Your audio or video file').setRequired(true))
                .addStringOption(opt =>
                    opt.setName('title').setDescription('Optional title for your piece').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('[Admin] Make a channel a Creator Showcase')
                .addChannelOption(opt =>
                    opt.setName('channel').setDescription('Channel to enable (defaults to current)')
                        .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('[Admin] Stop treating a channel as a Creator Showcase')
                .addChannelOption(opt =>
                    opt.setName('channel').setDescription('Channel to disable (defaults to current)')
                        .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub =>
            sub.setName('panel')
                .setDescription('[Admin] Make this a showcase channel and post an Upload button panel')
                .addChannelOption(opt =>
                    opt.setName('channel').setDescription('Channel for the panel (defaults to current)')
                        .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub =>
            sub.setName('list').setDescription('[Admin] List the Creator Showcase channels in this server')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        // `upload` is the public creator action.
        if (sub === 'upload') return handleShowcaseUploadCommand(interaction);

        // add/remove/list require Manage Channels.
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels)) {
            return interaction.reply({ content: 'You need **Manage Channels** to configure showcase channels.', ephemeral: true });
        }
        try {
            if (sub === 'add') {
                await interaction.deferReply({ ephemeral: true });
                const channel = interaction.options.getChannel('channel') || interaction.channel;
                await addShowcaseChannel(interaction.guildId, channel.id, interaction.user.id);
                return interaction.editReply(
                    `✅ <#${channel.id}> is now a **Creator Showcase**.\n` +
                    `Creators can post protected streams two ways:\n` +
                    `• **\`/showcase upload\`** in that channel — the recommended, private path (their file is never posted publicly).\n` +
                    `• Just **dropping a file** in the channel — convenient, but the raw file briefly hits Discord's CDN before I delete it.\n` +
                    `_Either way: I re-host it as a watermarked, download-disabled stream. Note that anything playable can still be screen/stream-captured — this stops casual downloading, not determined ripping._`
                );
            }
            if (sub === 'panel') {
                await interaction.deferReply({ ephemeral: true });
                const channel = interaction.options.getChannel('channel') || interaction.channel;
                await addShowcaseChannel(interaction.guildId, channel.id, interaction.user.id);
                const embed = new EmbedBuilder()
                    .setColor(0xF0A500)
                    .setTitle('🎶 Share your music & video')
                    .setDescription(
                        'Drop your **own** tracks and clips here as **protected streams** — they play in the browser, ' +
                        'watermarked, with **downloading disabled**.\n\n' +
                        'Tap **📤 Upload** below: you’ll get a private link, pick your file, and it posts here automatically. ' +
                        'Your file goes **straight to our server — never shared in Discord**.\n\n' +
                        '_Heads up: anything playable can still be screen-recorded — this stops casual downloading, not determined ripping._'
                    )
                    .setFooter({ text: 'Creator content • protected playback' });
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('showcase_upload').setLabel('Upload your music / video').setEmoji('📤').setStyle(ButtonStyle.Primary)
                );
                await channel.send({ embeds: [embed], components: [row] });
                return interaction.editReply(`✅ Posted the upload panel in <#${channel.id}> and enabled it as a Creator Showcase.`);
            }
            if (sub === 'remove') {
                await interaction.deferReply({ ephemeral: true });
                const channel = interaction.options.getChannel('channel') || interaction.channel;
                await removeShowcaseChannel(channel.id);
                return interaction.editReply(`Removed <#${channel.id}> from the Creator Showcase list.`);
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
