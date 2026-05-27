import logger from '../../utils/logger.js';
import { buildShopView, fetchProductsForBrowse } from '../../commands/community/fourthwall-handler.js';
import fourthwallScraper from '../../utils/scrapers/fourthwall-scraper.js';

// customId: fw_shop_page:<handle>:<targetPage>
export async function handleFourthwallShopPage(interaction) {
    const [, handle, pageStr] = interaction.customId.split(':');
    const page = parseInt(pageStr, 10);
    if (!handle || Number.isNaN(page)) {
        return interaction.reply({ content: 'Bad pagination state.', ephemeral: true });
    }

    await interaction.deferUpdate();
    try {
        const mgr = interaction.client.fourthwallManager;
        let target = { mode: 'scrape', handle };
        if (mgr) {
            const conn = await mgr.getConnection(interaction.guildId, handle);
            if (conn?.storefront_token) target = { mode: 'api', token: conn.storefront_token, handle };
        }

        const { shop, products } = await fetchProductsForBrowse(target);
        const view = buildShopView(shop, target, products, page);
        await interaction.editReply(view);
    } catch (err) {
        logger.error('[FW shop_page] failed', { err: err.message, handle, page });
        await interaction.followUp({ content: `Couldn't update shop view: ${err.message}`, ephemeral: true });
    }
}
