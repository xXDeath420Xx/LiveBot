import {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    MessageFlags,
} from 'discord.js';
import { catalogFor, categories } from '../../core/feature-flags.js';
import { themeColor } from '../../core/guild-theme.js';
import logger from '../../utils/logger.js';

/**
 * Browse what the bot can do, by capability rather than by command.
 *
 * `/help` already lists commands — but there are 76 root commands spelled with
 * 1,124 subcommands, and a list of those answers "what can I type" rather than
 * "what can this bot do for my server". The audit behind this found 211 of 443
 * guild-scoped features with zero rows across all 82 guilds: built, shipped, and
 * never adopted, largely because nobody could find them.
 *
 * So this is deliberately NOT a command list. It shows ~40 capabilities in plain
 * language, marks which are already running here, and points at the one command
 * or dashboard page that sets each one up.
 *
 * The default view leads with what is NOT yet set up, because someone running
 * this is looking for something they don't have. What they already use is one
 * click away rather than filling the first screen.
 */

const CATEGORY_EMOJI = {
    Community: '👥',
    Moderation: '🛡️',
    Streaming: '📡',
    Games: '🎮',
    Utility: '🔧',
    Personalisation: '🎨',
};

export default {
    category: 'tools',
    data: new SlashCommandBuilder()
        .setName('discover')
        .setDescription('Browse everything this bot can do for this server')
        .addStringOption((o) =>
            o
                .setName('category')
                .setDescription('Jump straight to one area')
                .addChoices(...categories().map((c) => ({ name: `${CATEGORY_EMOJI[c] || ''} ${c}`.trim(), value: c })))
        )
        .addStringOption((o) =>
            o
                .setName('show')
                .setDescription('Which features to list')
                .addChoices(
                    { name: 'Not set up yet (default)', value: 'inactive' },
                    { name: 'Already active here', value: 'active' },
                    { name: 'Everything', value: 'all' }
                )
        ),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({
                content: interaction.t?.('errors.guild_only') ?? 'That command only works inside a server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const catalog = await catalogFor(interaction.guild.id);
            const category = interaction.options.getString('category');
            const show = interaction.options.getString('show') || 'inactive';

            const embed = buildEmbed(interaction, catalog, { category, show });

            const menu = new StringSelectMenuBuilder()
                .setCustomId(`discover:${interaction.user.id}:${show}`)
                .setPlaceholder('Jump to a category…')
                .addOptions(
                    { label: 'Everything', value: '__all', emoji: '📚' },
                    ...categories().map((c) => {
                        const inCat = catalog.filter((f) => f.category === c);
                        return {
                            label: c,
                            value: c,
                            emoji: CATEGORY_EMOJI[c],
                            description: `${inCat.filter((f) => f.active).length} of ${inCat.length} active`,
                        };
                    })
                );

            return interaction.editReply({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(menu)],
            });
        } catch (error) {
            logger.error('[Discover] Failed', { guildId: interaction.guild.id, error: error.message, stack: error.stack });
            return interaction.editReply({
                content: interaction.t?.('errors.generic') ?? 'Something went wrong. Please try again.',
            });
        }
    },
};

function buildEmbed(interaction, catalog, { category, show }) {
    const activeCount = catalog.filter((f) => f.active).length;

    let features = catalog;
    if (category && category !== '__all') features = features.filter((f) => f.category === category);
    if (show === 'active') features = features.filter((f) => f.active);
    else if (show === 'inactive') features = features.filter((f) => !f.active);

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`What ${interaction.client.user.username} can do here`)
        .setFooter({
            text: `${activeCount} of ${catalog.length} features active in ${interaction.guild.name}`,
            iconURL: interaction.guild.iconURL() || undefined,
        });

    if (!features.length) {
        embed.setDescription(
            show === 'inactive'
                ? '**Everything is already set up.** Nothing left to enable in this view.'
                : 'Nothing to show here yet.'
        );
        return embed;
    }

    embed.setDescription(
        show === 'inactive'
            ? "Features that aren't running here yet. Most need nothing more than turning on."
            : show === 'active'
                ? 'Features already running in this server.'
                : 'Everything, with what\'s already on marked.'
    );

    // Group into one field per category so the embed stays scannable. Discord
    // caps a field value at 1024 chars, so long categories are truncated with an
    // honest note rather than silently cut — a list that lies about being
    // complete is the specific failure this command exists to fix.
    const byCategory = new Map();
    for (const feature of features) {
        if (!byCategory.has(feature.category)) byCategory.set(feature.category, []);
        byCategory.get(feature.category).push(feature);
    }

    for (const [cat, list] of byCategory) {
        const lines = [];
        let truncated = 0;
        let length = 0;

        for (const f of list) {
            const mark = f.active ? '🟢' : '⚪';
            const how = f.command ? ` — \`${f.command}\`` : '';
            const line = `${mark} **${f.name}**${how}\n${f.description}`;
            if (length + line.length + 1 > 1000) { truncated++; continue; }
            lines.push(line);
            length += line.length + 1;
        }

        if (truncated) lines.push(`*…and ${truncated} more — use \`/discover category:${cat}\`*`);

        embed.addFields({
            name: `${CATEGORY_EMOJI[cat] || ''} ${cat}`.trim(),
            value: lines.join('\n'),
        });
    }

    return embed;
}
