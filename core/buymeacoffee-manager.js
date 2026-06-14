import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';

const LOG_TAG = '[BMC]';
const BMC_API_BASE = 'https://developers.buymeacoffee.com/api/v1';

/**
 * Buy Me a Coffee integration manager.
 *
 * One read-only BMC account (key in env BMC_API_KEY, or a per-guild encrypted
 * override). Each configured guild announces new supporters/subscriptions/extras
 * independently via per-type high-water-marks stored in bmc_config.
 */
export default class BuyMeACoffeeManager {
    constructor(client) {
        this.client = client;
    }

    // ─── Config ──────────────────────────────────────────────────────

    async getConfig(guildId) {
        const [rows] = await pool.execute('SELECT * FROM bmc_config WHERE guild_id = ?', [guildId]);
        return rows[0] || null;
    }

    /**
     * Resolve the API key for a guild: decrypt the per-guild override if set,
     * else fall back to the env key.
     */
    async getApiKey(guildId) {
        const cfg = await this.getConfig(guildId);
        if (cfg?.api_key) {
            try {
                return encryption.decrypt(JSON.parse(cfg.api_key));
            } catch (error) {
                logger.error(`${LOG_TAG} Failed to decrypt api_key for guild ${guildId}`, { error: error.message });
            }
        }
        return process.env.BMC_API_KEY || null;
    }

    // ─── BMC API ─────────────────────────────────────────────────────

    /**
     * Fetch ALL pages for a single type and return a normalized array.
     * Handles the `{ error: "No supporters" }` empty shape → [].
     * Non-2xx (401 etc.) → throws with a clear message.
     */
    async _fetchType(apiKey, type) {
        const items = [];
        let page = 1;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const res = await fetch(`${BMC_API_BASE}/${type}?page=${page}`, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json',
                },
            });

            let body;
            try {
                body = await res.json();
            } catch {
                body = null;
            }

            if (!res.ok) {
                const msg = (body && (body.message || body.error)) || res.statusText || `HTTP ${res.status}`;
                throw new Error(`BMC API ${type} request failed (${res.status}): ${msg}`);
            }

            // Empty shape: { "error": "No supporters" } (string error) → treat as empty list
            if (body && typeof body.error === 'string') {
                break;
            }

            const data = Array.isArray(body?.data) ? body.data : [];
            for (const raw of data) {
                const normalized = this._normalize(raw, type);
                if (normalized) items.push(normalized);
            }

            const currentPage = Number(body?.current_page) || page;
            const lastPage = Number(body?.last_page) || currentPage;
            if (currentPage >= lastPage) break;
            page = currentPage + 1;
        }

        return items;
    }

    /**
     * Normalize a raw BMC record into:
     * { id, type, name, amountNum, currency, note, createdOn, hidden }
     */
    _normalize(raw, type) {
        try {
            if (type === 'supporters') {
                const price = parseFloat(raw.support_coffee_price) || 0;
                const coffees = parseInt(raw.support_coffees, 10) || 0;
                return {
                    id: String(raw.support_id),
                    type: 'supporter',
                    name: raw.payer_name || 'Anonymous',
                    amountNum: coffees * price,
                    currency: raw.support_currency || 'USD',
                    note: raw.support_note || null,
                    createdOn: raw.support_created_on || null,
                    hidden: Number(raw.support_visibility) === 0,
                };
            }

            if (type === 'subscriptions') {
                const price = parseFloat(raw.subscription_coffee_price) || 0;
                const coffees = parseInt(raw.subscription_coffee_num, 10) || 0;
                return {
                    id: String(raw.subscription_id),
                    type: 'subscription',
                    name: raw.payer_name || 'Anonymous',
                    amountNum: coffees * price,
                    currency: raw.subscription_currency || 'USD',
                    note: null,
                    createdOn: raw.subscription_created_on || null,
                    hidden: false,
                };
            }

            // extras — best effort
            const idVal =
                raw.purchase_id ??
                Object.entries(raw).find(([k]) => k.endsWith('_id'))?.[1];
            if (idVal === undefined || idVal === null) return null;

            const price =
                parseFloat(raw.extra_price ?? raw.purchase_price ?? raw.amount ?? 0) || 0;
            const qty = parseInt(raw.extra_num ?? raw.quantity ?? 1, 10) || 1;
            const amountNum = price * qty;

            return {
                id: String(idVal),
                type: 'extra',
                name: raw.payer_name || 'Anonymous',
                amountNum,
                currency: raw.extra_currency || raw.purchase_currency || raw.currency || 'USD',
                note: raw.extra_note || raw.purchase_note || null,
                createdOn: raw.extra_created_on || raw.purchase_created_on || raw.created_on || null,
                hidden: false,
            };
        } catch (error) {
            logger.warn(`${LOG_TAG} Failed to normalize ${type} record`, { error: error.message });
            return null;
        }
    }

    /**
     * Fetch all three types. Each is normalized (newest-first as returned by BMC).
     */
    async fetchAll(apiKey) {
        const [supporters, subscriptions, extras] = await Promise.all([
            this._fetchType(apiKey, 'supporters'),
            this._fetchType(apiKey, 'subscriptions'),
            this._fetchType(apiKey, 'extras'),
        ]);
        return { supporters, subscriptions, extras };
    }

    // ─── Config mutations ────────────────────────────────────────────

    /**
     * Upsert config with channel + enabled=1 AND baseline the high-water-marks
     * to the current max id per type, so existing supporters are NOT re-announced.
     * If the fetch fails, marks default to 0 (and we log).
     */
    async setChannel(guildId, channelId, setBy) {
        let lastSupport = 0;
        let lastSubscription = 0;
        let lastExtra = 0;

        try {
            const apiKey = await this.getApiKey(guildId);
            if (apiKey) {
                const { supporters, subscriptions, extras } = await this.fetchAll(apiKey);
                lastSupport = this._maxId(supporters);
                lastSubscription = this._maxId(subscriptions);
                lastExtra = this._maxId(extras);
            } else {
                logger.warn(`${LOG_TAG} No API key available to baseline guild ${guildId}; marks set to 0`);
            }
        } catch (error) {
            logger.error(`${LOG_TAG} Failed to baseline high-water-marks for guild ${guildId}`, { error: error.message });
        }

        await pool.execute(
            `INSERT INTO bmc_config
                (guild_id, channel_id, enabled, last_support_id, last_subscription_id, last_extra_id, set_by)
             VALUES (?, ?, 1, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                channel_id = VALUES(channel_id),
                enabled = 1,
                last_support_id = VALUES(last_support_id),
                last_subscription_id = VALUES(last_subscription_id),
                last_extra_id = VALUES(last_extra_id),
                set_by = VALUES(set_by)`,
            [guildId, channelId, lastSupport, lastSubscription, lastExtra, setBy]
        );

        return { lastSupport, lastSubscription, lastExtra };
    }

    async disable(guildId) {
        await pool.execute('UPDATE bmc_config SET enabled = 0 WHERE guild_id = ?', [guildId]);
    }

    async setApiKey(guildId, key, by) {
        const encrypted = JSON.stringify(encryption.encrypt(key));
        await pool.execute(
            `INSERT INTO bmc_config (guild_id, api_key, set_by)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE api_key = VALUES(api_key), set_by = VALUES(set_by)`,
            [guildId, encrypted, by]
        );
    }

    async clearApiKey(guildId) {
        await pool.execute('UPDATE bmc_config SET api_key = NULL WHERE guild_id = ?', [guildId]);
    }

    // ─── Polling / announcing ────────────────────────────────────────

    /**
     * Poll one guild: announce items whose numeric id > stored last_*_id
     * (oldest→newest), then advance the marks. Catches+logs its own errors.
     * @returns {number} total announced
     */
    async pollGuild(guildId) {
        try {
            const cfg = await this.getConfig(guildId);
            if (!cfg || !cfg.enabled || !cfg.channel_id) return 0;

            const apiKey = await this.getApiKey(guildId);
            if (!apiKey) {
                logger.warn(`${LOG_TAG} No API key for guild ${guildId}; skipping poll`);
                return 0;
            }

            const channel = await this.findChannel(guildId, cfg.channel_id);
            if (!channel) {
                logger.warn(`${LOG_TAG} Channel ${cfg.channel_id} not found for guild ${guildId}`);
                return 0;
            }

            const { supporters, subscriptions, extras } = await this.fetchAll(apiKey);

            let announced = 0;
            announced += await this._announceType(channel, cfg, supporters, BigInt(cfg.last_support_id || 0), 'last_support_id', guildId);
            announced += await this._announceType(channel, cfg, subscriptions, BigInt(cfg.last_subscription_id || 0), 'last_subscription_id', guildId);
            announced += await this._announceType(channel, cfg, extras, BigInt(cfg.last_extra_id || 0), 'last_extra_id', guildId);

            // Touch updated_at
            await pool.execute('UPDATE bmc_config SET updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?', [guildId]);

            return announced;
        } catch (error) {
            logger.error(`${LOG_TAG} pollGuild failed for guild ${guildId}`, { error: error.message });
            return 0;
        }
    }

    async _announceType(channel, cfg, items, lastId, column, guildId) {
        // New items: id > lastId, oldest→newest
        const fresh = items
            .filter(it => {
                try { return BigInt(it.id) > lastId; } catch { return false; }
            })
            .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

        if (fresh.length === 0) return 0;

        let announced = 0;
        let maxSeen = lastId;
        for (const item of fresh) {
            try {
                await channel.send({ embeds: [this.buildEmbed(item, cfg)] });
                announced++;
            } catch (error) {
                logger.error(`${LOG_TAG} Failed to send announcement in guild ${guildId}`, { error: error.message });
            }
            const idBig = BigInt(item.id);
            if (idBig > maxSeen) maxSeen = idBig;
        }

        // Advance high-water-mark to the max id seen (even on send failure, to avoid re-spam loops)
        await pool.execute(`UPDATE bmc_config SET ${column} = ? WHERE guild_id = ?`, [maxSeen.toString(), guildId]);

        return announced;
    }

    buildEmbed(item, cfg) {
        const titles = {
            supporter: '☕ New supporter!',
            subscription: '🎟️ New member!',
            extra: '🌟 New purchase!',
        };

        const showNames = cfg ? Number(cfg.show_names) !== 0 : true;
        const showAmounts = cfg ? Number(cfg.show_amounts) !== 0 : true;
        const color = (cfg && cfg.embed_color) || '#FFDD00';

        const embed = new EmbedBuilder()
            .setTitle(titles[item.type] || '☕ New support!')
            .setColor(color)
            .setTimestamp();

        const name = showNames && !item.hidden ? (item.name || 'Anonymous') : 'Anonymous';
        embed.setDescription(`**${name}** just showed some love! 💛`);

        if (showAmounts && item.amountNum > 0) {
            embed.addFields({
                name: 'Amount',
                value: item.amountNum.toLocaleString('en-US', {
                    style: 'currency',
                    currency: item.currency || 'USD',
                }),
                inline: true,
            });
        }

        if (item.note && !item.hidden) {
            embed.addFields({ name: 'Note', value: String(item.note).slice(0, 1024) });
        }

        return embed;
    }

    /**
     * Resolve a channel across the multi-bot fleet, then fall back to a fetch.
     */
    async findChannel(guildId, channelId) {
        if (global.botManager?.clients) {
            for (const [, botClient] of global.botManager.clients) {
                const guild = botClient.guilds.cache.get(guildId);
                if (guild) {
                    const ch = guild.channels.cache.get(channelId);
                    if (ch) return ch;
                }
            }
        }
        try {
            return await this.client?.channels?.fetch(channelId);
        } catch {
            return null;
        }
    }

    // ─── Aggregations (for slash command read-outs) ──────────────────

    _maxId(items) {
        let max = 0n;
        for (const it of items) {
            try {
                const b = BigInt(it.id);
                if (b > max) max = b;
            } catch { /* ignore non-numeric ids */ }
        }
        return max.toString();
    }

    /** Merge all types, newest-first, take limit. */
    async getRecent(apiKey, limit = 10) {
        const { supporters, subscriptions, extras } = await this.fetchAll(apiKey);
        const all = [...supporters, ...subscriptions, ...extras];
        all.sort((a, b) => {
            const ta = a.createdOn ? Date.parse(a.createdOn) : 0;
            const tb = b.createdOn ? Date.parse(b.createdOn) : 0;
            return tb - ta;
        });
        return all.slice(0, limit);
    }

    /** Aggregate by name across all types: { name, total, count, currency }. */
    async getTop(apiKey, limit = 10) {
        const { supporters, subscriptions, extras } = await this.fetchAll(apiKey);
        const all = [...supporters, ...subscriptions, ...extras];
        const byName = new Map();
        for (const it of all) {
            const key = it.name || 'Anonymous';
            const cur = byName.get(key) || { name: key, total: 0, count: 0, currency: it.currency || 'USD' };
            cur.total += it.amountNum || 0;
            cur.count += 1;
            byName.set(key, cur);
        }
        return [...byName.values()].sort((a, b) => b.total - a.total).slice(0, limit);
    }

    /** Totals across all types. */
    async getStats(apiKey) {
        const { supporters, subscriptions, extras } = await this.fetchAll(apiKey);
        const all = [...supporters, ...subscriptions, ...extras];
        const totalAmount = all.reduce((s, it) => s + (it.amountNum || 0), 0);
        return {
            supporterCount: supporters.length,
            memberCount: subscriptions.length,
            extraCount: extras.length,
            totalCoffees: all.length,
            totalAmount,
            currency: all.find(it => it.currency)?.currency || 'USD',
        };
    }
}
