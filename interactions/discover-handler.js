import { EmbedBuilder, MessageFlags } from 'discord.js';
import { catalogFor, categories } from '../core/feature-flags.js';
import { themeColor } from '../core/guild-theme.js';
import logger from '../utils/logger.js';

/**
 * Category dropdown on the /discover embed.
 *
 * customId: `discover:<userId>:<show>`
 *
 * Registered as a prefix handler, so it survives a restart without the original
 * message needing to be reposted — the whole state is in the customId.
 */

const CATEGORY_EMOJI = {
    Community: '👥',
    Moderation: '🛡️',
    Streaming: '📡',
    Games: '🎮',
    Utility: '🔧',
    Personalisation: '🎨',
};

export async function handleDiscoverSelect(interaction) {
    const [, ownerId, show = 'inactive'] = interaction.customId.split(':');

    // The reply is ephemeral, so only the invoker can see it anyway — but a
    // component customId is client-supplied, so check rather than assume.
    if (ownerId && interaction.user.id !== ownerId) {
        return interaction.reply({
            content: interaction.t?.('errors.no_permission') ?? "That menu isn't yours — run `/discover` to get your own.",
            flags: MessageFlags.Ephemeral,
        });
    }

    const chosen = interaction.values?.[0] ?? '__all';

    try {
        await interaction.deferUpdate();

        const catalog = await catalogFor(interaction.guild.id);
        const activeCount = catalog.filter((f) => f.active).length;

        let features = catalog;
        if (chosen !== '__all') features = features.filter((f) => f.category === chosen);
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
                    ? '**Everything here is already set up.**'
                    : 'Nothing to show in this category.'
            );
        } else {
            embed.setDescription(
                chosen === '__all'
                    ? 'Everything, grouped by area.'
                    : `**${chosen}** — ${features.filter((f) => f.active).length} of ${catalog.filter((f) => f.category === chosen).length} active.`
            );

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
                    const line = `${f.active ? '🟢' : '⚪'} **${f.name}**${f.command ? ` — \`${f.command}\`` : ''}\n${f.description}`;
                    // Discord caps a field value at 1024. Say what was dropped
                    // rather than cut silently — a catalog that quietly omits
                    // things is the exact failure this feature exists to fix.
                    if (length + line.length + 1 > 1000) { truncated++; continue; }
                    lines.push(line);
                    length += line.length + 1;
                }
                if (truncated) lines.push(`*…and ${truncated} more*`);

                embed.addFields({ name: `${CATEGORY_EMOJI[cat] || ''} ${cat}`.trim(), value: lines.join('\n') });
            }
        }

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Discover] Select failed', { error: error.message, customId: interaction.customId });
        return interaction.followUp({
            content: interaction.t?.('errors.generic') ?? 'Something went wrong. Please try again.',
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
    }
}

export { categories };
