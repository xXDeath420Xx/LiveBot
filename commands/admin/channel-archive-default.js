/*
 * /channel-archive-default — set the default thread auto-archive duration on
 * a text or forum channel. New threads created there inherit this value
 * unless the creator explicitly picks another.
 *
 * Discord enum (minutes): 60 · 1440 (1 day) · 4320 (3 days) · 10080 (1 week).
 * Guilds past boost tier 2 unlock the longer durations. Lower tiers get
 * silently capped by Discord — our validator doesn't preempt that.
 */
import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    ChannelType,
    ThreadAutoArchiveDuration,
} from 'discord.js';
import logger from '../../utils/logger.js';

const DURATIONS = [
    { name: '1 hour',  value: ThreadAutoArchiveDuration.OneHour  },
    { name: '1 day',   value: ThreadAutoArchiveDuration.OneDay   },
    { name: '3 days',  value: ThreadAutoArchiveDuration.ThreeDays },
    { name: '1 week',  value: ThreadAutoArchiveDuration.OneWeek  },
];

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('channel-archive-default')
        .setDescription('Set the default thread auto-archive duration on a text or forum channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addChannelOption(o => o
            .setName('channel')
            .setDescription('The parent channel threads are created from')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildAnnouncement, ChannelType.GuildMedia)
            .setRequired(true))
        .addIntegerOption(o => o
            .setName('duration')
            .setDescription('New default for threads created here')
            .setRequired(true)
            .addChoices(...DURATIONS)),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: 'Server-only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const channel = interaction.options.getChannel('channel', true);
        const duration = interaction.options.getInteger('duration', true);

        try {
            await channel.edit({ defaultAutoArchiveDuration: duration }, `Set by ${interaction.user.tag}`);
            const label = DURATIONS.find(d => d.value === duration)?.name ?? `${duration} min`;
            logger.info('[channel-archive-default] updated', {
                guildId: interaction.guild.id, channelId: channel.id,
                duration, by: interaction.user.id,
            });
            return interaction.editReply({
                content: `${channel} — new threads will auto-archive after **${label}** of inactivity.`,
            });
        } catch (err) {
            if (err?.code === 50013) return interaction.editReply({ content: 'Discord refused — bot missing Manage Channels on that channel.' });
            if (err?.code === 50035) return interaction.editReply({ content: 'Server boost tier too low for that duration (3-day needs Tier 1+, 7-day Tier 2+).' });
            logger.error('[channel-archive-default] failed', { err: err.message });
            return interaction.editReply({ content: `Failed: ${err.message}` });
        }
    },
};
