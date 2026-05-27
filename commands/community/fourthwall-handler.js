import {
    ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    EmbedBuilder, PermissionFlagsBits
} from 'discord.js';
import logger from '../../utils/logger.js';
import { storefrontClient } from '../../utils/fourthwall-api.js';
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
    const modal = new ModalBuilder()
        .setCustomId('fourthwall_setup_submit')
        .setTitle('Connect Fourthwall Shop')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('handle').setLabel('Shop handle (URL slug)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('api_user').setLabel('Platform API username').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255).setPlaceholder('fw_api_xxxxx@fourthwall.com')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('api_pass').setLabel('Platform API password').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('storefront_token').setLabel('Storefront token (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(255).setPlaceholder('ptkn_...')
            )
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

async function pickStorefrontToken(interaction, explicitHandle) {
    if (explicitHandle) {
        const conn = await mgr(interaction).getConnection(interaction.guildId, explicitHandle);
        if (conn?.storefront_token) return { token: conn.storefront_token, handle: explicitHandle };
    }
    const conns = await mgr(interaction).listConnections(interaction.guildId);
    const first = conns[0];
    if (!first) throw new Error('No connected shop in this guild. Pass a shop handle or run /fourthwall setup.');
    const full = await mgr(interaction).getConnection(interaction.guildId, first.shop_handle);
    return { token: full?.storefront_token || null, handle: first.shop_handle };
}

export async function handleShop(interaction) {
    await interaction.deferReply();
    const explicit = interaction.options.getString('handle');
    const { token, handle } = await pickStorefrontToken(interaction, explicit);
    const sf = storefrontClient(token);
    const shop = await sf.getShop();
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(shop.name || handle)
        .setURL(shop.url || null)
        .setDescription(truncate(sanitizeUserText(shop.description || ''), 500));
    await interaction.editReply({ embeds: [embed] });
}

export async function handleProduct(interaction) {
    await interaction.deferReply();
    const slug = interaction.options.getString('slug');
    const explicit = interaction.options.getString('shop');
    const { token } = await pickStorefrontToken(interaction, explicit);
    const sf = storefrontClient(token);
    const prod = await sf.getProduct(slug);
    const price = prod.price?.amount ? formatCurrency(prod.price.amount, prod.price.currency) : '—';
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(sanitizeUserText(prod.name || slug))
        .setURL(prod.url || null)
        .setDescription(truncate(sanitizeUserText(prod.description || ''), 500))
        .addFields({ name: 'Price', value: price, inline: true });
    if (prod.image) embed.setImage(prod.image);
    await interaction.editReply({ embeds: [embed] });
}

export async function handleCollection(interaction) {
    await interaction.deferReply();
    const slug = interaction.options.getString('slug');
    const explicit = interaction.options.getString('shop');
    const { token } = await pickStorefrontToken(interaction, explicit);
    const sf = storefrontClient(token);
    const col = await sf.getCollection(slug);
    const items = (col.products || []).slice(0, 10).map(p => `• ${sanitizeUserText(p.name)} — ${p.price ? formatCurrency(p.price.amount, p.price.currency) : '—'}`).join('\n');
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(sanitizeUserText(col.name || slug))
        .setDescription(items || '_(empty collection)_');
    await interaction.editReply({ embeds: [embed] });
}

export async function handleSearch(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('query');
    const explicit = interaction.options.getString('shop');
    const { token } = await pickStorefrontToken(interaction, explicit);
    const sf = storefrontClient(token);
    const results = await sf.searchProducts(query);
    const list = (results.items || results.products || []).slice(0, 10);
    const lines = list.map(p => `• **${sanitizeUserText(p.name)}** — ${p.price ? formatCurrency(p.price.amount, p.price.currency) : '—'}`).join('\n');
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(`Search: ${sanitizeUserText(query)}`)
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
