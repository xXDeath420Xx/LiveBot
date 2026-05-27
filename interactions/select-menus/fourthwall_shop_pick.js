import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import fourthwallScraper from '../../utils/scrapers/fourthwall-scraper.js';
import { storefrontClient } from '../../utils/fourthwall-api.js';
import { sanitizeUserText, truncate, formatCurrency, EMBED_DEFAULT_COLOR } from '../../core/fourthwall-helpers.js';

// customId: fw_shop_pick:<handle>
// values: [slug]
export async function handleFourthwallShopPick(interaction) {
    const [, handle] = interaction.customId.split(':');
    const slug = interaction.values?.[0];
    if (!handle || !slug) {
        return interaction.reply({ content: 'Bad selection.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
        // Use the connected-shop Storefront API if available, otherwise scrape.
        let prod;
        const mgr = interaction.client.fourthwallManager;
        if (mgr) {
            const conn = await mgr.getConnection(interaction.guildId, handle);
            if (conn?.storefront_token) {
                prod = await storefrontClient(conn.storefront_token).getProduct(slug);
            }
        }
        if (!prod) prod = await fourthwallScraper.getProduct(handle, slug);

        const baseUrl = `https://${handle}.fourthwall.com`;
        const productUrl = prod.url || `${baseUrl}/products/${slug}/`;
        const priceText = prod.price?.display
            || (prod.price?.amount ? formatCurrency(prod.price.amount, prod.price.currency) : '—');

        const embed = new EmbedBuilder()
            .setColor(EMBED_DEFAULT_COLOR)
            .setTitle(sanitizeUserText(prod.name || slug))
            .setURL(productUrl)
            .setDescription(truncate(sanitizeUserText(prod.description || ''), 500))
            .addFields({ name: 'Price', value: priceText, inline: true });
        if (prod.image) embed.setImage(prod.image);

        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        logger.error('[FW shop_pick] failed', { err: err.message, handle, slug });
        await interaction.editReply(`Couldn't load product: ${err.message}`);
    }
}
