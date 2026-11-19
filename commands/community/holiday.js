import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    ChannelType,
    EmbedBuilder,
} from 'discord.js';
import logger from '../../utils/logger.js';
import {
    HOLIDAY_CATALOG,
    listCatalog,
    getHoliday,
    computeCountdown,
    computeGuildCountdown,
    applyGuildHolidayConfig,
    listGuildConfig,
    buildCountdownEmbed,
    publicCountdownUrl,
    pinCountdownMessage,
    unpinCountdownMessage,
    formatHolidayDate,
} from '../../core/holiday-manager.js';

const LOG = '[/holiday]';

// Choices for the subcommands that pick a holiday. Discord caps string
// choices at 25; the catalog is right at that limit so no truncation is
// needed yet. If we ever exceed 25, swap to autocomplete.
const SLUG_CHOICES = HOLIDAY_CATALOG.map(h => ({ name: `${h.emoji} ${h.label}`, value: h.slug }));

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('holiday')
        .setDescription('Holiday countdowns — Christmas, Halloween, Easter, Diwali, Lunar New Year and more')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('countdown')
                .setDescription('Show the countdown to a specific holiday')
                .addStringOption(o => o.setName('holiday')
                    .setDescription('Which holiday')
                    .setRequired(true)
                    .addChoices(...SLUG_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List every holiday with its days-remaining, nearest first'))
        .addSubcommand(sub =>
            sub.setName('share')
                .setDescription('Post a countdown with a public share link (auto-unfurls when re-shared)')
                .addStringOption(o => o.setName('holiday')
                    .setDescription('Which holiday')
                    .setRequired(true)
                    .addChoices(...SLUG_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('pin')
                .setDescription('Pin a live countdown message in a channel (edits daily, no re-post spam)')
                .addStringOption(o => o.setName('holiday')
                    .setDescription('Which holiday')
                    .setRequired(true)
                    .addChoices(...SLUG_CHOICES))
                .addChannelOption(o => o.setName('channel')
                    .setDescription('Channel to pin in — defaults to the current channel')
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('unpin')
                .setDescription('Remove the live countdown pin for a holiday')
                .addStringOption(o => o.setName('holiday')
                    .setDescription('Which holiday')
                    .setRequired(true)
                    .addChoices(...SLUG_CHOICES)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'countdown' || sub === 'share') {
            const slug = interaction.options.getString('holiday');
            // Uses this server's name/emoji for the holiday and respects it being turned off.
            const info = await computeGuildCountdown(interaction.guildId, slug);
            if (!info) {
                return interaction.reply({ content: `Unknown holiday \`${slug}\`.`, flags: MessageFlags.Ephemeral });
            }
            if (!info.enabled) {
                return interaction.reply({ content: `${info.label} countdowns are turned off in this server.`, flags: MessageFlags.Ephemeral });
            }
            const url = publicCountdownUrl(slug);
            const embed = buildCountdownEmbed(info, { linkUrl: url });
            // `share` posts the raw URL first — Discord will auto-unfurl it
            // using the public page's OG tags, so re-shares show the same
            // rich preview without the bot having to be there to post it.
            if (sub === 'share') {
                return interaction.reply({ content: url, embeds: [embed] });
            }
            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'list') {
            await interaction.deferReply();
            // Per-server names, emoji and on/off (holiday_countdowns); catalog defaults outside a server.
            let guildRows = new Map();
            if (interaction.guildId) {
                try {
                    const cfg = await listGuildConfig(interaction.guildId);
                    guildRows = new Map(cfg.map(c => [c.slug, {
                        enabled: c.enabled, label_override: c.labelOverride, emoji_override: c.emojiOverride,
                    }]));
                } catch (e) {
                    logger.warn(`${LOG} list: guild config unavailable: ${e.message}`);
                }
            }
            const results = [];
            for (const h of listCatalog()) {
                try {
                    const info = applyGuildHolidayConfig(await computeCountdown(h.slug), guildRows.get(h.slug) || null);
                    if (info && info.enabled) results.push(info);
                } catch (e) {
                    logger.warn(`${LOG} list skipped ${h.slug}: ${e.message}`);
                }
            }
            results.sort((a, b) => a.daysRemaining - b.daysRemaining);

            const lines = results.map(r => {
                const d = r.isToday ? '**today!**' : `**${r.daysRemaining}d**`;
                return `${r.emoji} ${d.padEnd(16)} · ${r.label} — ${formatHolidayDate(r.nextDate)}`;
            });

            const embed = new EmbedBuilder()
                .setTitle('🗓️ Holiday countdowns')
                .setDescription(lines.join('\n') || '*No holidays configured.*')
                .setColor(0x5865F2)
                .setFooter({ text: 'Pin a live one with /holiday pin · share a link with /holiday share' });
            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'pin' || sub === 'unpin') {
            const slug = interaction.options.getString('holiday');
            if (!getHoliday(slug)) {
                return interaction.reply({ content: `Unknown holiday \`${slug}\`.`, flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            if (sub === 'pin') {
                const chOpt = interaction.options.getChannel('channel');
                const channel = chOpt || interaction.channel;
                if (!channel?.isTextBased?.()) {
                    return interaction.editReply('That channel can\'t receive a countdown message.');
                }
                try {
                    const msg = await pinCountdownMessage(interaction.client, {
                        guildId: interaction.guildId,
                        slug,
                        channelId: channel.id,
                    });
                    return interaction.editReply(
                        `Pinned live countdown for **${getHoliday(slug).label}** in <#${channel.id}>. ` +
                        `[Jump to message](${msg.url}). It will edit itself every ~6 hours.`
                    );
                } catch (e) {
                    logger.warn(`${LOG} pin failed: ${e.message}`, { slug, guildId: interaction.guildId });
                    return interaction.editReply(`Pin failed: ${e.message}`);
                }
            }

            try {
                const ok = await unpinCountdownMessage(interaction.client, {
                    guildId: interaction.guildId,
                    slug,
                });
                return interaction.editReply(ok
                    ? `Removed the live countdown pin for **${getHoliday(slug).label}**.`
                    : `No pin was set for **${getHoliday(slug).label}**.`);
            } catch (e) {
                return interaction.editReply(`Unpin failed: ${e.message}`);
            }
        }

        return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
    },
};
