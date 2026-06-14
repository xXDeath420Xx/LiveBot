import {
    SlashCommandBuilder,
    EmbedBuilder,
    ChannelType,
    MessageFlags,
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
} from 'discord.js';
import logger from '../../utils/logger.js';

const LOG_TAG = '[BMC]';
const BMC_COLOR = '#FFDD00';

const KEY_HELP =
    'Generate a **read-only** API key at ' +
    'developers.buymeacoffee.com → Settings → API.';

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('buymeacoffee')
        .setDescription('Link your Buy Me a Coffee and announce your own supporters')

        // ── Per-user account linking ──
        .addSubcommand(sub =>
            sub.setName('link')
                .setDescription('Link YOUR Buy Me a Coffee account (opens a private form for your key)'))

        .addSubcommand(sub =>
            sub.setName('unlink')
                .setDescription('Remove your Buy Me a Coffee link and all announcements'))

        // ── Per-guild announce subscription ──
        .addSubcommand(sub =>
            sub.setName('announce')
                .setDescription('Announce YOUR new supporters in a channel here')
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Channel for your supporter announcements')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)))

        .addSubcommand(sub =>
            sub.setName('stop')
                .setDescription('Stop announcing your supporters in this server'))

        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Show your link and where your supporters are announced'))

        // ── Read-outs for YOUR account ──
        .addSubcommand(sub =>
            sub.setName('recent')
                .setDescription('Show your recent supporters')
                .addIntegerOption(opt =>
                    opt.setName('count')
                        .setDescription('How many to show (1-15)')
                        .setMinValue(1).setMaxValue(15)))

        .addSubcommand(sub =>
            sub.setName('top')
                .setDescription('Show your top supporters leaderboard')
                .addIntegerOption(opt =>
                    opt.setName('count')
                        .setDescription('How many to show (1-20)')
                        .setMinValue(1).setMaxValue(20)))

        .addSubcommand(sub =>
            sub.setName('stats')
                .setDescription('Show your Buy Me a Coffee totals'))

        .addSubcommand(sub =>
            sub.setName('link-help')
                .setDescription('How to get your read-only Buy Me a Coffee API key'))

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

            const userId = interaction.user.id;
            const guildId = interaction.guildId;

            switch (sub) {
                case 'link': {
                    // Open a private modal so the key is entered in a form, never typed as a
                    // visible command option (and never posted). Submission → bmc_link_submit.
                    const modal = new ModalBuilder()
                        .setCustomId('bmc_link_submit')
                        .setTitle('Link Buy Me a Coffee');
                    const keyInput = new TextInputBuilder()
                        .setCustomId('api_key')
                        .setLabel('Your read-only BMC API key')
                        .setPlaceholder('Paste your read-only key — stored encrypted, never shown')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true);
                    modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
                    return interaction.showModal(modal);
                }

                case 'unlink': {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    await manager.unlinkUser(userId);
                    return interaction.editReply('🔓 Your Buy Me a Coffee link and all announcements have been removed.');
                }

                case 'announce': {
                    if (!guildId) {
                        return interaction.reply({ content: '⚠️ Use this in a server.', flags: MessageFlags.Ephemeral });
                    }
                    const channel = interaction.options.getChannel('channel');
                    // You may only route YOUR supporter alerts to a channel you can post in
                    // yourself — stops a member binding the bot to staff/announcement channels.
                    const perms = channel.permissionsFor(interaction.member);
                    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
                        return interaction.reply({
                            content: `🚫 You can only announce in a channel you can post in yourself — you don't have permission to send messages in <#${channel.id}>.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    await manager.setAnnounce(userId, guildId, channel.id, userId);
                    return interaction.editReply(
                        `✅ Your new Buy Me a Coffee supporters will be announced in <#${channel.id}>.\n` +
                        'Only **future** support is announced (your existing supporters were baselined at link time).'
                    );
                }

                case 'stop': {
                    if (!guildId) {
                        return interaction.reply({ content: '⚠️ Use this in a server.', flags: MessageFlags.Ephemeral });
                    }
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    await manager.stopAnnounce(userId, guildId);
                    return interaction.editReply('🛑 Your supporter announcements are disabled in this server.');
                }

                case 'status': {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const status = await manager.getUserStatus(userId);
                    if (!status.linked) {
                        return interaction.editReply('☕ You have not linked a Buy Me a Coffee account. Use `/buymeacoffee link`.');
                    }
                    const masked = status.accountId
                        ? `\`${status.accountId}\``
                        : '_unknown_';
                    const targetLines = status.targets.length
                        ? status.targets.map(t =>
                            `• <#${t.channel_id}> in \`${t.guild_id}\` — ${Number(t.enabled) ? '🟢 on' : '🔴 off'}`
                        ).join('\n')
                        : '_No announcement channels yet — use `/buymeacoffee announce`._';
                    const embed = new EmbedBuilder()
                        .setColor(BMC_COLOR)
                        .setTitle('☕ Your Buy Me a Coffee')
                        .addFields(
                            { name: 'Account', value: masked, inline: true },
                            { name: 'Announcing in', value: targetLines },
                        )
                        .setTimestamp();
                    return interaction.editReply({ embeds: [embed] });
                }

                case 'recent': {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const apiKey = await manager.getApiKeyForUser(userId);
                    if (!apiKey) return interaction.editReply('☕ Link first with `/buymeacoffee link`.');
                    const count = interaction.options.getInteger('count') || 10;
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
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const apiKey = await manager.getApiKeyForUser(userId);
                    if (!apiKey) return interaction.editReply('☕ Link first with `/buymeacoffee link`.');
                    const count = interaction.options.getInteger('count') || 10;
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
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const apiKey = await manager.getApiKeyForUser(userId);
                    if (!apiKey) return interaction.editReply('☕ Link first with `/buymeacoffee link`.');
                    const s = await manager.getStats(apiKey);
                    const embed = new EmbedBuilder()
                        .setColor(BMC_COLOR)
                        .setTitle('☕ Your Buy Me a Coffee Stats')
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

                case 'link-help': {
                    const embed = new EmbedBuilder()
                        .setColor(BMC_COLOR)
                        .setTitle('☕ Linking your Buy Me a Coffee')
                        .setDescription(
                            'Buy Me a Coffee data is **private to each creator**, so everyone links ' +
                            'their **own** account — there is no shared/server-wide key.\n\n' +
                            '**Steps:**\n' +
                            '1. Go to **developers.buymeacoffee.com**\n' +
                            '2. Open **Settings → API**\n' +
                            '3. Generate a **read-only** API key (it only reads supporters — it can\'t spend or change anything)\n' +
                            '4. Run `/buymeacoffee link` — a **private form** opens where you paste the key (it\'s never shown or posted; stored encrypted). You can also link it securely on the **dashboard**.\n' +
                            '5. Run `/buymeacoffee announce` in any server to post your supporters there'
                        );
                    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
                }

                default:
                    return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            logger.error(`${LOG_TAG} Command error in /buymeacoffee ${sub}`, { error: error.message, stack: error.stack });
            const payload = { content: `❌ ${error.message || 'Something went wrong with Buy Me a Coffee.'}` };
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(payload).catch(() => {});
            }
            return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    },
};
