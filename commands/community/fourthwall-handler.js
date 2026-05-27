import {
    ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    EmbedBuilder, PermissionFlagsBits,
    ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} from 'discord.js';
import logger from '../../utils/logger.js';
import { storefrontClient } from '../../utils/fourthwall-api.js';
import fourthwallScraper from '../../utils/scrapers/fourthwall-scraper.js';
import { sanitizeUserText, truncate, formatCurrency, EMBED_DEFAULT_COLOR, parseHexColor } from '../../core/fourthwall-helpers.js';

function requireManage(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('Requires Manage Server permission');
    }
}

function mgr(interaction) {
    const m = interaction.client.fourthwallManager;
    if (!m) throw new Error('Fourthwall manager not initialized on this bot');
    return m;
}

export async function handleSetup(interaction) {
    requireManage(interaction);

    // Pre-fill from .env defaults so the bot owner doesn't have to retype their own creds.
    // FW_DEFAULT_API_USERNAME / FW_DEFAULT_API_PASSWORD / FW_DEFAULT_STOREFRONT_TOKEN.
    // Discord limits TextInput defaults to 4000 chars; our values are far shorter.
    const defaultUser = process.env.FW_DEFAULT_API_USERNAME || '';
    const defaultPass = process.env.FW_DEFAULT_API_PASSWORD || '';
    const defaultStorefront = process.env.FW_DEFAULT_STOREFRONT_TOKEN || '';

    const handleInput = new TextInputBuilder()
        .setCustomId('handle').setLabel('Shop handle (URL slug)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
        .setPlaceholder('e.g. mamabear-xal-shop');

    const apiUserInput = new TextInputBuilder()
        .setCustomId('api_user').setLabel('Platform API username')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255)
        .setPlaceholder('fw_api_xxxxx@fourthwall.com');
    if (defaultUser) apiUserInput.setValue(defaultUser);

    const apiPassInput = new TextInputBuilder()
        .setCustomId('api_pass').setLabel('Platform API password')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255);
    if (defaultPass) apiPassInput.setValue(defaultPass);

    const storefrontInput = new TextInputBuilder()
        .setCustomId('storefront_token').setLabel('Storefront token (optional)')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(255)
        .setPlaceholder('ptkn_...');
    if (defaultStorefront) storefrontInput.setValue(defaultStorefront);

    const modal = new ModalBuilder()
        .setCustomId('fourthwall_setup_submit')
        .setTitle('Connect Fourthwall Shop')
        .addComponents(
            new ActionRowBuilder().addComponents(handleInput),
            new ActionRowBuilder().addComponents(apiUserInput),
            new ActionRowBuilder().addComponents(apiPassInput),
            new ActionRowBuilder().addComponents(storefrontInput)
        );
    await interaction.showModal(modal);
}

export async function handleDisconnect(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const result = await mgr(interaction).disconnectShop({ guildId: interaction.guildId, shopHandle: shop });
    await interaction.editReply(`Disconnected **${shop}**. Removed ${result.removed} webhooks, orphaned ${result.orphaned}.`);
}

export async function handleList(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const conns = await mgr(interaction).listConnections(interaction.guildId);
    if (conns.length === 0) {
        return interaction.editReply('No shops connected. Use `/fourthwall setup` to connect one.');
    }
    const lines = conns.map(c => {
        const last = c.last_event_at ? `<t:${Math.floor(new Date(c.last_event_at).getTime()/1000)}:R>` : 'never';
        return `• **${c.shop_handle}** — ${c.shop_name || ''} · last event: ${last}`;
    });
    await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR).setTitle('Connected Fourthwall shops').setDescription(lines.join('\n'))]
    });
}

export async function handleResync(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const hours = interaction.options.getInteger('hours') || 24;
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    const platform = mgr(interaction).platformForConnection(conn);
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    // Resync deliberately re-fires events that may already have been delivered via webhook.
    // It is a recovery tool, not a normal flow — we accept duplicate Discord posts in exchange
    // for guaranteeing that anything FW recorded in the window ends up in the channel.
    let replayed = 0;
    try {
        const orders = await platform.listOrders({ since, limit: 25 });
        for (const o of (orders.items || orders || [])) {
            await mgr(interaction).handleEvent('ORDER_PLACED', o, conn);
            replayed++;
        }
        const donations = await platform.listDonations({ since, limit: 25 });
        for (const d of (donations.items || donations || [])) {
            await mgr(interaction).handleEvent('ORDER_DONATION', d, conn);
            replayed++;
        }
    } catch (err) {
        logger.warn('[FW resync] partial', { err: err.message });
    }
    await interaction.editReply(
        `Replayed ${replayed} events from the last ${hours}h. ` +
        `Note: this may produce duplicate posts for events already delivered via webhook.`
    );
}

export async function handleRoute(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const category = interaction.options.getString('category');
    const channel = interaction.options.getChannel('channel');
    const enabled = interaction.options.getBoolean('enabled') ?? true;
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    await mgr(interaction).setRouting({ connectionId: conn.id, category, channelId: channel.id, enabled });
    await interaction.editReply(`✓ ${category} for **${shop}** → <#${channel.id}> (${enabled ? 'enabled' : 'disabled'})`);
}

export async function handleDefaultChannel(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    await mgr(interaction).setGuildConfig(interaction.guildId, { default_channel_id: channel.id });
    await interaction.editReply(`✓ Default channel set to <#${channel.id}>`);
}

export async function handlePrivacy(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const patch = {};
    const sn = interaction.options.getBoolean('show_names');
    const sa = interaction.options.getBoolean('show_amounts');
    if (sn !== null) patch.show_customer_names = sn ? 1 : 0;
    if (sa !== null) patch.show_amounts = sa ? 1 : 0;
    if (Object.keys(patch).length === 0) throw new Error('Pass at least one of show_names or show_amounts');
    await mgr(interaction).setGuildConfig(interaction.guildId, patch);
    const cfg = await mgr(interaction).getGuildConfig(interaction.guildId);
    await interaction.editReply(`Privacy: show_names=**${!!cfg.show_customer_names}**, show_amounts=**${!!cfg.show_amounts}**`);
}

// Browse commands work against ANY shop by handle, no setup required.
// If the user explicitly names a handle (or the URL slug from a fourthwall.com link),
// we scrape the public storefront. If they don't pass one, we try the guild's connected
// shop's Storefront API (richer data) — that path needs setup.
function parseShopHandle(input) {
    if (!input) return null;
    const trimmed = String(input).trim();
    const urlMatch = /^https?:\/\/([a-z0-9-]+)\.fourthwall\.com/i.exec(trimmed);
    if (urlMatch) return urlMatch[1].toLowerCase();
    if (/^[a-z0-9-]{1,100}$/i.test(trimmed)) return trimmed.toLowerCase();
    return null;
}

async function resolveBrowseTarget(interaction, explicitInput) {
    const parsed = parseShopHandle(explicitInput);
    if (parsed) {
        // Prefer connected-shop API (storefront token) when this guild owns the handle.
        const conn = await mgr(interaction).getConnection(interaction.guildId, parsed);
        if (conn?.storefront_token) return { mode: 'api', token: conn.storefront_token, handle: parsed };
        return { mode: 'scrape', handle: parsed };
    }
    // No explicit handle: fall back to first connected shop in this guild.
    const conns = await mgr(interaction).listConnections(interaction.guildId);
    const first = conns[0];
    if (!first) throw new Error('Pass a shop handle (e.g. `mamabear-xal-shop`) or a full URL.');
    const full = await mgr(interaction).getConnection(interaction.guildId, first.shop_handle);
    if (full?.storefront_token) return { mode: 'api', token: full.storefront_token, handle: first.shop_handle };
    return { mode: 'scrape', handle: first.shop_handle };
}

const PRODUCTS_PER_PAGE = 10;

// Build a single-page view: shop-header embed + a product-list embed + nav components.
// `products` is `[{slug, name, image, price}]`.
export function buildShopView(shop, target, products, page = 0) {
    const baseUrl = shop.url || `https://${target.handle}.fourthwall.com/`;
    const totalPages = Math.max(1, Math.ceil(products.length / PRODUCTS_PER_PAGE));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const start = safePage * PRODUCTS_PER_PAGE;
    const slice = products.slice(start, start + PRODUCTS_PER_PAGE);

    const headerEmbed = new EmbedBuilder()
        .setColor(EMBED_DEFAULT_COLOR)
        .setTitle(shop.name || target.handle)
        .setURL(baseUrl)
        .setDescription(truncate(sanitizeUserText(shop.description || ''), 500))
        .setFooter({ text: `${products.length} products${totalPages > 1 ? ` · page ${safePage + 1}/${totalPages}` : ''}` });
    if (shop.image) headerEmbed.setThumbnail(shop.image);

    const listLines = slice.map((p, i) => {
        const n = start + i + 1;
        const productUrl = `${baseUrl.replace(/\/+$/, '')}/products/${p.slug}/`;
        const priceText = p.price?.display
            || (p.price?.amount ? formatCurrency(p.price.amount, p.price.currency) : '—');
        // Discord markdown link inside an embed description renders as clickable text.
        return `**${n}.** [${sanitizeUserText(p.name)}](${productUrl}) — ${priceText}`;
    });

    const listEmbed = new EmbedBuilder()
        .setColor(EMBED_DEFAULT_COLOR)
        .setTitle(`Products — ${shop.name || target.handle}`)
        .setURL(baseUrl)
        .setDescription(listLines.join('\n') || '_no products found_');

    const components = [];

    if (slice.length > 0) {
        // Select menu — pick a product to see full detail. customId is parsed by the handler.
        const select = new StringSelectMenuBuilder()
            .setCustomId(`fw_shop_pick:${target.handle}`)
            .setPlaceholder('View product details…')
            .addOptions(slice.map(p =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(truncate(p.name, 100))
                    .setValue(p.slug.slice(0, 100))
                    .setDescription(truncate(p.price?.display || (p.price?.amount ? formatCurrency(p.price.amount, p.price.currency) : ''), 100) || undefined)
            ));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    if (totalPages > 1) {
        const prev = new ButtonBuilder()
            .setCustomId(`fw_shop_page:${target.handle}:${safePage - 1}`)
            .setLabel('◀ Prev')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage === 0);
        const next = new ButtonBuilder()
            .setCustomId(`fw_shop_page:${target.handle}:${safePage + 1}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage >= totalPages - 1);
        const open = new ButtonBuilder()
            .setLabel('Open shop')
            .setStyle(ButtonStyle.Link)
            .setURL(baseUrl);
        components.push(new ActionRowBuilder().addComponents(prev, next, open));
    } else {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Open shop').setStyle(ButtonStyle.Link).setURL(baseUrl)
        ));
    }

    return { embeds: [headerEmbed, listEmbed], components };
}

export async function fetchProductsForBrowse(target) {
    if (target.mode === 'api') {
        // Storefront API path: shop info + product listing. Different field names than scraper.
        const sf = storefrontClient(target.token);
        const shop = await sf.getShop();
        let products = [];
        try {
            const list = await sf.searchProducts('');
            const items = list.items || list.products || [];
            products = items.map(p => ({
                slug: p.handle || p.slug || p.id,
                name: p.name || p.title,
                image: p.images?.[0]?.url || p.image,
                price: p.price?.amount ? { amount: p.price.amount, currency: p.price.currency, display: null } : null
            }));
        } catch (err) {
            logger.warn('[FW Browse] API product list failed; using shop-only view', { err: err.message });
        }
        return { shop, products };
    }
    const shop = await fourthwallScraper.getShop(target.handle);
    return { shop, products: shop.products || [] };
}

export async function handleShop(interaction) {
    await interaction.deferReply();
    const explicit = interaction.options.getString('handle');
    const target = await resolveBrowseTarget(interaction, explicit);

    const { shop, products } = await fetchProductsForBrowse(target);
    const view = buildShopView(shop, target, products, 0);
    await interaction.editReply(view);
}

export async function handleProduct(interaction) {
    await interaction.deferReply();
    const slug = interaction.options.getString('slug');
    const explicit = interaction.options.getString('shop');
    const target = await resolveBrowseTarget(interaction, explicit);

    let prod;
    if (target.mode === 'api') {
        prod = await storefrontClient(target.token).getProduct(slug);
    } else {
        prod = await fourthwallScraper.getProduct(target.handle, slug);
    }
    const price = prod.price?.amount ? formatCurrency(prod.price.amount, prod.price.currency) : '—';
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(sanitizeUserText(prod.name || slug))
        .setURL(prod.url || `https://${target.handle}.fourthwall.com/products/${slug}/`)
        .setDescription(truncate(sanitizeUserText(prod.description || ''), 500))
        .addFields({ name: 'Price', value: price, inline: true });
    if (prod.image) embed.setImage(prod.image);
    await interaction.editReply({ embeds: [embed] });
}

export async function handleCollection(interaction) {
    await interaction.deferReply();
    const slug = interaction.options.getString('slug');
    const explicit = interaction.options.getString('shop');
    const target = await resolveBrowseTarget(interaction, explicit);

    let col;
    if (target.mode === 'api') {
        col = await storefrontClient(target.token).getCollection(slug);
    } else {
        col = await fourthwallScraper.getCollection(target.handle, slug);
    }
    const apiItems = (col.products || []).slice(0, 10).map(p => `• ${sanitizeUserText(p.name)} — ${p.price ? formatCurrency(p.price.amount, p.price.currency) : '—'}`);
    const scrapedItems = (col.productHandles || []).slice(0, 10).map(h => `• \`${h}\``);
    const lines = (apiItems.length ? apiItems : scrapedItems).join('\n');
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(sanitizeUserText(col.name || slug))
        .setURL(`https://${target.handle}.fourthwall.com/collections/${slug}/`)
        .setDescription(lines || '_(empty collection)_');
    await interaction.editReply({ embeds: [embed] });
}

export async function handleSearch(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('query');
    const explicit = interaction.options.getString('shop');
    const target = await resolveBrowseTarget(interaction, explicit);

    let products;
    if (target.mode === 'api') {
        const results = await storefrontClient(target.token).searchProducts(query);
        products = (results.items || results.products || []).slice(0, 10);
    } else {
        const r = await fourthwallScraper.searchProducts(target.handle, query);
        products = r.products || [];
    }
    const lines = products.map(p => `• **${sanitizeUserText(p.name)}** — ${p.price ? formatCurrency(p.price.amount, p.price.currency) : '—'}`).join('\n');
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(`Search: ${sanitizeUserText(query)}`)
        .setURL(`https://${target.handle}.fourthwall.com/`)
        .setDescription(lines || '_no results_');
    await interaction.editReply({ embeds: [embed] });
}

export async function handlePromotions(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const explicit = interaction.options.getString('shop');
    let conn = null;
    if (explicit) {
        conn = await mgr(interaction).getConnection(interaction.guildId, explicit);
    } else {
        const conns = await mgr(interaction).listConnections(interaction.guildId);
        if (conns.length) conn = await mgr(interaction).getConnection(interaction.guildId, conns[0].shop_handle);
    }
    if (!conn) throw new Error('No connected shop. Pass a shop handle or run /fourthwall setup.');
    const platform = mgr(interaction).platformForConnection(conn);
    const promos = await platform.listPromotions();
    const list = (promos.items || promos || []).slice(0, 10);
    const lines = list.map(p => `\`${p.code}\` — ${p.discount} · expires ${p.expiresAt ? `<t:${Math.floor(new Date(p.expiresAt).getTime()/1000)}:R>` : 'never'}`).join('\n');
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR).setTitle('Promotions').setDescription(lines || '_(none)_');
    await interaction.editReply({ embeds: [embed] });
}

export async function handleStats(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const period = interaction.options.getString('period') || '30d';
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    const platform = mgr(interaction).platformForConnection(conn);
    const sinceDays = period === '7d' ? 7 : period === '30d' ? 30 : null;
    const since = sinceDays ? new Date(Date.now() - sinceDays * 86400_000).toISOString() : undefined;

    const orders = await platform.listOrders({ since, limit: 25 }).catch(() => ({ items: [] }));
    const donations = await platform.listDonations({ since, limit: 25 }).catch(() => ({ items: [] }));
    const members = await platform.listMembers({ limit: 25 }).catch(() => ({ items: [] }));

    const orderItems = orders.items || orders || [];
    const donationItems = donations.items || donations || [];
    const memberItems = members.items || members || [];
    const revenue = orderItems.reduce((acc, o) => acc + (o.total || 0), 0);

    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(`Stats — ${shop} (${period})`)
        .addFields(
            { name: 'Orders', value: String(orderItems.length), inline: true },
            { name: 'Revenue', value: formatCurrency(revenue, orderItems[0]?.currency || 'USD'), inline: true },
            { name: 'Donations', value: String(donationItems.length), inline: true },
            { name: 'Members (recent)', value: String(memberItems.length), inline: true }
        );
    await interaction.editReply({ embeds: [embed] });
}

export async function handleRecent(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const kind = interaction.options.getString('kind');
    const limit = interaction.options.getInteger('limit') || 10;
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    const platform = mgr(interaction).platformForConnection(conn);
    let items = [];
    if (kind === 'orders') {
        const r = await platform.listOrders({ limit });
        items = (r.items || r || []).map(o => `• ${o.orderNumber || o.id} — ${formatCurrency(o.total || 0, o.currency)}`);
    } else if (kind === 'donations') {
        const r = await platform.listDonations({ limit });
        items = (r.items || r || []).map(d => `• ${formatCurrency(d.amount || 0, d.currency)} — ${sanitizeUserText(d.customerName || 'anon')}`);
    } else {
        const r = await platform.listMembers({ limit });
        items = (r.items || r || []).map(m => `• ${sanitizeUserText(m.customerName || m.email || '?')} — ${sanitizeUserText(m.tierName || '?')}`);
    }
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(`Recent ${kind} — ${shop}`)
        .setDescription(items.join('\n') || '_(none)_');
    await interaction.editReply({ embeds: [embed] });
}

export async function handleGiveaway(interaction, sub) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    const platform = mgr(interaction).platformForConnection(conn);

    if (sub === 'draw') {
        const id = interaction.options.getString('id');
        const result = await platform.triggerGiveawayDraw(id);
        await interaction.editReply(`Drew giveaway **${id}** — winner: ${sanitizeUserText(result.winner || '?')}`);
    } else if (sub === 'list') {
        const r = await platform.listGiveaways();
        const items = (r.items || r || []).slice(0, 10).map(g => `• ${g.id} — ${sanitizeUserText(g.prize || '?')}`);
        const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR).setTitle(`Giveaways — ${shop}`).setDescription(items.join('\n') || '_(none)_');
        await interaction.editReply({ embeds: [embed] });
    }
}
