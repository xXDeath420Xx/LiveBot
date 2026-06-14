import {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
} from 'discord.js';
import logger from '../../utils/logger.js';

const LOG_TAG = '[BMC]';
const BMC_COLOR = '#FFDD00';

function isAdminSub(sub) {
    return ['setup', 'disable', 'connect', 'disconnect', 'test'].includes(sub);
}

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('buymeacoffee')
        .setDescription('Buy Me a Coffee integration — announce new supporters & view stats')

        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Announce new supporters in a channel')
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Channel for supporter announcements')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)))

        .addSubcommand(sub =>
            sub.setName('disable')
                .setDescription('Stop announcing new supporters'))

        .addSubcommand(sub =>
            sub.setName('connect')
                .setDescription('Use a custom Buy Me a Coffee API key for this server')
                .addStringOption(opt =>
                    opt.setName('api_key')
                        .setDescription('Your read-only BMC API key (stored encrypted)')
                        .setRequired(true)))

        .addSubcommand(sub =>
            sub.setName('disconnect')
                .setDescription('Remove this server\'s custom API key (revert to default)'))

        .addSubcommand(sub =>
            sub.setName('test')
                .setDescription('Post a sample supporter announcement to verify permissions'))

        .addSubcommand(sub =>
            sub.setName('recent')
                .setDescription('Show recent supporters')
                .addIntegerOption(opt =>
                    opt.setName('count')
                        .setDescription('How many to show (1-15)')
                        .setMinValue(1).setMaxValue(15)))

        .addSubcommand(sub =>
            sub.setName('top')
                .setDescription('Show top supporters leaderboard')
                .addIntegerOption(opt =>
                    opt.setName('count')
                        .setDescription('How many to show (1-20)')
                        .setMinValue(1).setMaxValue(20)))

        .addSubcommand(sub =>
            sub.setName('stats')
                .setDescription('Show Buy Me a Coffee totals'))

        .addSubcommand(sub =>
            sub.setName('link')
                .setDescription('Get the Buy Me a Coffee link'))

        .setDefaultMemberPermissions(null),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const manager = interaction.client.buymeacoffeeManager;

        try {
            if (!manager) {
                const payload = { content: '☕ Buy Me a Coffee is still initializing — try again in a moment.' };
                return interaction.deferred || interaction.replied
                    ? interaction.editReply(payload)
                    : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            }

            // Admin gate for privileged subcommands
            if (isAdminSub(sub) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({
                    content: '🚫 You need the **Administrator** permission to do that.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const guildId = interaction.guildId;

            switch (sub) {
                case 'setup': {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const channel = interaction.options.getChannel('channel');
                    const marks = await manager.setChannel(guildId, channel.id, interaction.user.id);
                    return interaction.editReply(
                        `✅ New Buy Me a Coffee supporters will now be announced in <#${channel.id}>.\n` +
                        `Existing supporters were baselined (support #${marks.lastSupport}, sub #${marks.lastSubscription}, extra #${marks.lastExtra}) — only **future** support will be announced.`
                    );
                }

                case 'disable': {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    await manager.disable(guildId);
                    return interaction.editReply('🛑 Buy Me a Coffee announcements disabled for this server.');
                }

                case 'connect': {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const key = interaction.options.getString('api_key');
                    await manager.setApiKey(guildId, key, interaction.user.id);
                    return interaction.editReply('🔐 Custom API key stored (encrypted). This server will now use it.');
                }

                case 'disconnect': {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    await manager.clearApiKey(guildId);
                    return interaction.editReply('🔓 Custom API key removed. Reverted to the default key.');
                }

                case 'test': {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const cfg = await manager.getConfig(guildId);
                    if (!cfg || !cfg.channel_id) {
                        return interaction.editReply('⚠️ No announcement channel configured. Run `/buymeacoffee setup` first.');
                    }
                    const channel = await manager.findChannel(guildId, cfg.channel_id);
                    if (!channel) {
                        return interaction.editReply(`⚠️ Configured channel <#${cfg.channel_id}> not found.`);
                    }
                    const sample = {
                        id: '0',
                        type: 'supporter',
                        name: 'Test Supporter',
                        amountNum: 5,
                        currency: 'USD',
                        note: 'This is a sample announcement to verify permissions. ☕',
                        createdOn: new Date().toISOString(),
                        hidden: false,
                    };
                    try {
                        await channel.send({ embeds: [manager.buildEmbed(sample, cfg)] });
                    } catch (err) {
                        return interaction.editReply(`❌ Couldn't post in <#${cfg.channel_id}> — check my permissions. (${err.message})`);
                    }
                    return interaction.editReply(`✅ Sample announcement posted in <#${cfg.channel_id}>.`);
                }

                case 'recent': {
                    await interaction.deferReply();
                    const count = interaction.options.getInteger('count') || 10;
                    const apiKey = await manager.getApiKey(guildId);
                    if (!apiKey) return interaction.editReply('⚠️ No Buy Me a Coffee API key is configured.');
                    const items = await manager.getRecent(apiKey, count);
                    if (items.length === 0) return interaction.editReply('☕ No supporters yet.');
                    const lines = items.map(it => {
                        const amt = it.amountNum > 0
                            ? it.amountNum.toLocaleString('en-US', { style: 'currency', currency: it.currency || 'USD' })
                            : '';
                        const name = it.hidden ? 'Anonymous' : (it.name || 'Anonymous');
                        return `• **${name}** ${amt}`.trim();
                    });
                    const embed = new EmbedBuilder()
                        .setColor(BMC_COLOR)
                        .setTitle('☕ Recent Supporters')
                        .setDescription(lines.join('\n'))
                        .setTimestamp();
                    return interaction.editReply({ embeds: [embed] });
                }

                case 'top': {
                    await interaction.deferReply();
                    const count = interaction.options.getInteger('count') || 10;
                    const apiKey = await manager.getApiKey(guildId);
                    if (!apiKey) return interaction.editReply('⚠️ No Buy Me a Coffee API key is configured.');
                    const top = await manager.getTop(apiKey, count);
                    if (top.length === 0) return interaction.editReply('☕ No supporters yet.');
                    const medals = ['🥇', '🥈', '🥉'];
                    const lines = top.map((t, i) => {
                        const rank = medals[i] || `**${i + 1}.**`;
                        const amt = t.total.toLocaleString('en-US', { style: 'currency', currency: t.currency || 'USD' });
                        return `${rank} **${t.name}** — ${amt} (${t.count})`;
                    });
                    const embed = new EmbedBuilder()
                        .setColor(BMC_COLOR)
                        .setTitle('🏆 Top Supporters')
                        .setDescription(lines.join('\n'))
                        .setTimestamp();
                    return interaction.editReply({ embeds: [embed] });
                }

                case 'stats': {
                    await interaction.deferReply();
                    const apiKey = await manager.getApiKey(guildId);
                    if (!apiKey) return interaction.editReply('⚠️ No Buy Me a Coffee API key is configured.');
                    const s = await manager.getStats(apiKey);
                    const embed = new EmbedBuilder()
                        .setColor(BMC_COLOR)
                        .setTitle('☕ Buy Me a Coffee Stats')
                        .addFields(
                            { name: 'Supporters', value: `${s.supporterCount}`, inline: true },
                            { name: 'Members', value: `${s.memberCount}`, inline: true },
                            { name: 'Extras', value: `${s.extraCount}`, inline: true },
                            { name: 'Total Contributions', value: `${s.totalCoffees}`, inline: true },
                            {
                                name: 'Total Raised',
                                value: s.totalAmount.toLocaleString('en-US', { style: 'currency', currency: s.currency || 'USD' }),
                                inline: true,
                            },
                        )
                        .setTimestamp();
                    return interaction.editReply({ embeds: [embed] });
                }

                case 'link': {
                    const embed = new EmbedBuilder()
                        .setColor(BMC_COLOR)
                        .setTitle('☕ Support us on Buy Me a Coffee')
                        .setDescription('[Buy Me a Coffee](https://www.buymeacoffee.com/)');
                    return interaction.reply({ embeds: [embed] });
                }

                default:
                    return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            logger.error(`${LOG_TAG} Command error in /buymeacoffee ${sub}`, { error: error.message, stack: error.stack });
            const payload = { content: '❌ Something went wrong with Buy Me a Coffee. Please try again.' };
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(payload).catch(() => {});
            }
            return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    },
};
