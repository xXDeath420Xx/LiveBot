import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';
import { platformClient, storefrontClient } from '../utils/fourthwall-api.js';
import {
    generateConnectionToken, pseudonymFor, sanitizeUserText, truncate, formatCurrency,
    EVENT_CATEGORY_MAP, ALL_EVENT_TYPES, parseHexColor, EMBED_DEFAULT_COLOR
} from './fourthwall-helpers.js';
import { EmbedBuilder } from 'discord.js';

function encryptStr(value) {
    return JSON.stringify(encryption.encrypt(value));
}
function decryptStr(value) {
    if (!value) return null;
    try {
        return encryption.decrypt(JSON.parse(value));
    } catch (err) {
        logger.error('[FW Manager] Failed to decrypt', { err: err.message });
        return null;
    }
}

export default class FourthwallManager {
    constructor(client) {
        this.client = client;
    }

    // ── Connection lifecycle ─────────────────────────────────────────────────

    async connectShop({ guildId, shopHandle, apiUser, apiPass, storefrontToken, connectedBy }) {
        const webhookBase = process.env.FOURTHWALL_WEBHOOK_BASE_URL;
        if (!webhookBase) throw new Error('FOURTHWALL_WEBHOOK_BASE_URL not configured');

        const platform = platformClient(apiUser, apiPass);
        const shop = await platform.getShop();

        const connectionToken = generateConnectionToken();
        const webhookUrl = `${webhookBase.replace(/\/+$/, '')}/webhooks/fourthwall/${connectionToken}`;

        const [insert] = await pool.execute(
            `INSERT INTO fourthwall_connections
                (guild_id, shop_handle, shop_name, shop_id, api_username, api_password,
                 storefront_token, connection_token, connected_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                guildId, shopHandle, shop.name || shopHandle, shop.id || null,
                encryptStr(apiUser), encryptStr(apiPass),
                storefrontToken || null, connectionToken, connectedBy
            ]
        );
        const connectionId = insert.insertId;

        // Register webhooks. First successful create returns the shared HMAC secret.
        const registered = [];
        let webhookSecret = null;
        for (const eventType of ALL_EVENT_TYPES) {
            try {
                const created = await platform.createWebhook({ url: webhookUrl, eventType });
                registered.push({ id: created.id, eventType });
                if (!webhookSecret && created.secret) webhookSecret = created.secret;
            } catch (err) {
                logger.warn('[FW Manager] webhook create failed', {
                    connectionId, eventType, err: err.message
                });
            }
        }
        if (!webhookSecret) {
            // Best-effort: try to delete any webhooks that did get created (they'd point at our
            // 404 URL otherwise). If delete fails, orphan them so the daily cleanup retries.
            const encUser = encryptStr(apiUser);
            const encPass = encryptStr(apiPass);
            for (const wh of registered) {
                try {
                    await platform.deleteWebhook(wh.id);
                } catch (err) {
                    await pool.execute(
                        `INSERT INTO fourthwall_orphan_webhooks (connection_id, webhook_id, api_username, api_password) VALUES (?, ?, ?, ?)`,
                        [connectionId, wh.id, encUser, encPass]
                    ).catch(e => logger.error('[FW Manager] orphan insert on partial-fail', { err: e.message }));
                }
            }
            await pool.execute(`DELETE FROM fourthwall_connections WHERE id = ?`, [connectionId]);
            throw new Error('Fourthwall returned no webhook secret — webhook registration failed entirely.');
        }

        await pool.execute(
            `UPDATE fourthwall_connections SET webhook_secret = ?, webhook_ids = ? WHERE id = ?`,
            [encryptStr(webhookSecret), JSON.stringify(registered), connectionId]
        );

        // Seed default routing (cart_abandoned starts disabled — internal-only).
        const categories = ['orders','donations','memberships','giveaways','promotions','newsletter','thank_you','cart_abandoned'];
        for (const cat of categories) {
            await pool.execute(
                `INSERT IGNORE INTO fourthwall_event_routing (connection_id, event_category, enabled) VALUES (?, ?, ?)`,
                [connectionId, cat, cat === 'cart_abandoned' ? 0 : 1]
            );
        }

        return { connectionId, registeredEvents: registered.length, shopName: shop.name };
    }

    async disconnectShop({ guildId, shopHandle }) {
        const [rows] = await pool.execute(
            `SELECT id, api_username, api_password, webhook_ids
             FROM fourthwall_connections WHERE guild_id = ? AND shop_handle = ?`,
            [guildId, shopHandle]
        );
        if (rows.length === 0) throw new Error('Shop not connected to this guild');
        const conn = rows[0];

        const apiUser = decryptStr(conn.api_username);
        const apiPass = decryptStr(conn.api_password);
        const platform = platformClient(apiUser, apiPass);
        const webhookIds = conn.webhook_ids ? (typeof conn.webhook_ids === 'string' ? JSON.parse(conn.webhook_ids) : conn.webhook_ids) : [];

        let removed = 0, orphaned = 0;
        for (const wh of webhookIds) {
            try {
                await platform.deleteWebhook(wh.id);
                removed++;
            } catch (err) {
                orphaned++;
                await pool.execute(
                    `INSERT INTO fourthwall_orphan_webhooks (connection_id, webhook_id, api_username, api_password)
                     VALUES (?, ?, ?, ?)`,
                    [conn.id, wh.id, conn.api_username, conn.api_password]
                );
                logger.warn('[FW Manager] webhook delete failed, orphaning', { id: wh.id, err: err.message });
            }
        }

        await pool.execute(`DELETE FROM fourthwall_connections WHERE id = ?`, [conn.id]);
        return { removed, orphaned };
    }

    async listConnections(guildId) {
        const [rows] = await pool.execute(
            `SELECT id, shop_handle, shop_name, last_event_at, connected_at
             FROM fourthwall_connections WHERE guild_id = ? ORDER BY connected_at DESC`,
            [guildId]
        );
        return rows;
    }

    async getConnection(guildId, shopHandle) {
        const [rows] = await pool.execute(
            `SELECT * FROM fourthwall_connections WHERE guild_id = ? AND shop_handle = ?`,
            [guildId, shopHandle]
        );
        return rows[0] || null;
    }

    async getConnectionById(id) {
        const [rows] = await pool.execute(
            `SELECT * FROM fourthwall_connections WHERE id = ?`, [id]
        );
        return rows[0] || null;
    }

    platformForConnection(conn) {
        const user = decryptStr(conn.api_username);
        const pass = decryptStr(conn.api_password);
        return platformClient(user, pass);
    }

    // ── Routing ─────────────────────────────────────────────────────────────

    async setRouting({ connectionId, category, channelId, enabled }) {
        await pool.execute(
            `INSERT INTO fourthwall_event_routing (connection_id, event_category, channel_id, enabled)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), enabled = VALUES(enabled)`,
            [connectionId, category, channelId || null, enabled ? 1 : 0]
        );
    }

    async getRouting(connectionId, category) {
        const [rows] = await pool.execute(
            `SELECT channel_id, enabled FROM fourthwall_event_routing
             WHERE connection_id = ? AND event_category = ?`,
            [connectionId, category]
        );
        return rows[0] || null;
    }

    async getGuildConfig(guildId) {
        const [rows] = await pool.execute(
            `SELECT * FROM fourthwall_guild_config WHERE guild_id = ?`, [guildId]
        );
        return rows[0] || {
            guild_id: guildId, default_channel_id: null,
            show_customer_names: 0, show_amounts: 1, embed_color: '#FF6B35'
        };
    }

    async setGuildConfig(guildId, patch) {
        const current = await this.getGuildConfig(guildId);
        const next = { ...current, ...patch };
        await pool.execute(
            `INSERT INTO fourthwall_guild_config
                (guild_id, default_channel_id, show_customer_names, show_amounts, embed_color)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                default_channel_id = VALUES(default_channel_id),
                show_customer_names = VALUES(show_customer_names),
                show_amounts = VALUES(show_amounts),
                embed_color = VALUES(embed_color)`,
            [
                guildId, next.default_channel_id,
                next.show_customer_names ? 1 : 0,
                next.show_amounts ? 1 : 0,
                next.embed_color
            ]
        );
    }

    async resolveChannelId(connection, category) {
        const route = await this.getRouting(connection.id, category);
        if (route && route.enabled && route.channel_id) return route.channel_id;
        if (route && !route.enabled) return null; // explicitly off
        const cfg = await this.getGuildConfig(connection.guild_id);
        return cfg.default_channel_id || null;
    }

    // ── Event handling ──────────────────────────────────────────────────────

    async handleEvent(eventType, payload, connection) {
        const category = EVENT_CATEGORY_MAP[eventType];
        if (!category) {
            logger.info('[FW Manager] unmapped event type', { eventType, connectionId: connection.id });
            return;
        }

        const channelId = await this.resolveChannelId(connection, category);
        if (!channelId) {
            logger.info('[FW Manager] no channel routed', { category, connectionId: connection.id });
            return;
        }

        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            logger.warn('[FW Manager] channel not fetchable', { channelId, category });
            return;
        }

        const cfg = await this.getGuildConfig(connection.guild_id);
        const embed = this.buildEmbed(eventType, payload, connection, cfg);
        if (!embed) return;

        await channel.send({
            embeds: [embed],
            allowedMentions: { parse: [] }
        }).catch(err => {
            logger.error('[FW Manager] send failed', { channelId, err: err.message });
        });

        await pool.execute(
            `UPDATE fourthwall_connections SET last_event_at = NOW() WHERE id = ?`,
            [connection.id]
        );
    }

    buildEmbed(eventType, payload, connection, cfg) {
        const color = parseHexColor(cfg.embed_color);
        const category = EVENT_CATEGORY_MAP[eventType];
        switch (category) {
            case 'orders': return this.buildOrderEmbed(eventType, payload, connection, cfg, color);
            case 'donations': return this.buildDonationEmbed(payload, connection, cfg, color);
            case 'memberships': return this.buildMembershipEmbed(eventType, payload, connection, cfg, color);
            case 'giveaways': return this.buildGiveawayEmbed(eventType, payload, connection, cfg, color);
            case 'promotions': return this.buildPromotionEmbed(eventType, payload, connection, cfg, color);
            case 'newsletter': return this.buildNewsletterEmbed(payload, connection, cfg, color);
            case 'thank_you': return this.buildThankYouEmbed(payload, connection, cfg, color);
            case 'cart_abandoned': return this.buildCartAbandonedEmbed(eventType, payload, connection, cfg, color);
            default: return null;
        }
    }

    nameFor(customerId, customerName, cfg, connection) {
        if (cfg.show_customer_names && customerName) return sanitizeUserText(customerName);
        return pseudonymFor(customerId || 'anon', connection.guild_id);
    }

    buildOrderEmbed(eventType, p, connection, cfg, color) {
        const name = this.nameFor(p.customerId, p.customerName, cfg, connection);
        const items = (p.items || []).slice(0, 3).map(i => `• ${sanitizeUserText(i.name)} × ${sanitizeUserText(String(i.quantity ?? '?'))}`).join('\n');
        const more = (p.items || []).length > 3 ? `\n…and ${p.items.length - 3} more` : '';
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(eventType === 'GIFT_PURCHASE' ? '🎁 New gift purchase' : '🛒 New order')
            .setDescription(`From **${name}**`)
            .addFields({ name: 'Items', value: (items + more) || '_(unknown)_' });
        if (cfg.show_amounts && p.total != null) {
            embed.addFields({ name: 'Total', value: formatCurrency(p.total, p.currency), inline: true });
        }
        if (p.shippingCountry) embed.addFields({ name: 'Ships to', value: String(p.shippingCountry), inline: true });
        if (p.orderNumber) embed.setFooter({ text: `Order …${String(p.orderNumber).slice(-4)}` });
        embed.setTimestamp(new Date(p.createdAt || Date.now()));
        return embed;
    }

    buildDonationEmbed(p, connection, cfg, color) {
        const name = this.nameFor(p.customerId, p.customerName, cfg, connection);
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle('💝 New donation')
            .setDescription(`**${name}** sent a donation!`);
        if (cfg.show_amounts && p.amount != null) {
            embed.addFields({ name: 'Amount', value: `**${formatCurrency(p.amount, p.currency)}**`, inline: true });
        }
        if (p.message) {
            embed.addFields({ name: 'Message', value: truncate(sanitizeUserText(p.message), 500) });
        }
        embed.setTimestamp(new Date(p.createdAt || Date.now()));
        return embed;
    }

    buildMembershipEmbed(eventType, p, connection, cfg, color) {
        const name = this.nameFor(p.customerId, p.customerName, cfg, connection);
        const verb = eventType === 'SUBSCRIPTION_PURCHASED' ? 'joined'
                   : eventType === 'SUBSCRIPTION_CHANGED' ? 'changed tier'
                   : 'expired';
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🎟 Membership ${verb}`)
            .setDescription(`**${name}** — ${sanitizeUserText(p.tierName || 'unknown tier')}`);
        if (p.period) embed.addFields({ name: 'Period', value: sanitizeUserText(p.period), inline: true });
        embed.setTimestamp(new Date(p.eventAt || Date.now()));
        return embed;
    }

    buildGiveawayEmbed(eventType, p, connection, cfg, color) {
        const ended = eventType === 'GIVEAWAY_DRAW_ENDED';
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🎁 Giveaway ${ended ? 'ended' : 'started'}`)
            .setDescription(sanitizeUserText(p.prize || 'Giveaway draw'))
            .addFields(
                { name: 'Draw ID', value: String(p.drawId || '—'), inline: true },
                { name: 'Entries', value: String(p.entryCount ?? '—'), inline: true }
            );
        if (ended && p.winner) {
            embed.addFields({ name: '🏆 Winner', value: sanitizeUserText(p.winner) });
        }
        return embed;
    }

    buildPromotionEmbed(eventType, p, connection, cfg, color) {
        const statusVerb = eventType === 'PROMOTION_CREATED' ? 'created'
                         : eventType === 'PROMOTION_STATUS_CHANGED' ? sanitizeUserText(String(p.status || 'updated'))
                         : 'updated';
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🏷 Promo ${statusVerb}`)
            .addFields(
                { name: 'Code', value: '`' + sanitizeUserText(p.code || '—') + '`', inline: true },
                { name: 'Discount', value: sanitizeUserText(String(p.discount || '—')), inline: true }
            );
        if (p.expiresAt) {
            const ts = Math.floor(new Date(p.expiresAt).getTime() / 1000);
            if (Number.isFinite(ts)) {
                embed.addFields({ name: 'Expires', value: `<t:${ts}:R>`, inline: true });
            }
        }
        return embed;
    }

    buildNewsletterEmbed(p, connection, cfg, color) {
        return new EmbedBuilder()
            .setColor(color)
            .setTitle('📬 New newsletter subscriber')
            .setDescription('A new subscriber joined the shop newsletter.');
    }

    buildThankYouEmbed(p, connection, cfg, color) {
        const name = this.nameFor(p.customerId, p.customerName, cfg, connection);
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle('✨ Thank-you message sent')
            .setDescription(`To **${name}**`);
        if (p.message) {
            embed.addFields({ name: 'Message', value: truncate(sanitizeUserText(p.message), 500) });
        }
        return embed;
    }

    buildCartAbandonedEmbed(eventType, p, connection, cfg, color) {
        const after = eventType === 'CART_ABANDONED_72H' ? '72h'
                    : eventType === 'CART_ABANDONED_24H' ? '24h' : '1h';
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🛒 Abandoned cart (${after})`);
        if (cfg.show_amounts && p.total != null) {
            embed.addFields({ name: 'Cart total', value: formatCurrency(p.total, p.currency), inline: true });
        }
        return embed;
    }
}

export { decryptStr };
