import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';

const LOG_TAG = '[BMC]';
const BMC_API_BASE = 'https://developers.buymeacoffee.com/api/v1';

/**
 * Buy Me a Coffee integration manager — per-USER multi-tenant model.
 *
 * ANY user in ANY guild links THEIR OWN BMC read-only API key (`bmc_user_links`),
 * then announces THEIR supporters in one channel per guild (`bmc_announce`).
 * Mirrors the Throne two-table split (user→account; per-guild subscription→channel).
 */
export default class BuyMeACoffeeManager {
    constructor(client) {
        this.client = client;
    }

    // ─── Key helpers ─────────────────────────────────────────────────

    /**
     * The BMC read-only key is a JWT. Base64-decode the payload (middle segment)
     * and return `sub` (the account id) for display. Returns null on any failure.
     */
    decodeAccountId(apiKey) {
        try {
            const parts = String(apiKey).split('.');
            if (parts.length < 2) return null;
            const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const json = Buffer.from(payloadB64, 'base64').toString('utf8');
            const payload = JSON.parse(json);
            return payload?.sub != null ? String(payload.sub) : null;
        } catch {
            return null;
        }
    }

    /**
     * Validate a key by hitting the supporters endpoint.
     * 200 (even `{ error: "No supporters" }`) → valid (true).
     * 401/403 → invalid (false). Network/other error → throw.
     */
    async validateKey(apiKey) {
        let res;
        try {
            res = await fetch(`${BMC_API_BASE}/supporters?page=1`, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json',
                },
            });
        } catch (error) {
            throw new Error(`Could not reach Buy Me a Coffee: ${error.message}`);
        }
        if (res.status === 401 || res.status === 403) return false;
        if (res.ok) return true;
        // Other non-2xx — treat as a transient failure to surface
        throw new Error(`Buy Me a Coffee returned HTTP ${res.status}`);
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

    // ─── User links ──────────────────────────────────────────────────

    /**
     * Link a user to their own BMC account. Validates the key first; baselines
     * the per-type high-water-marks to the current max id so existing supporters
     * are NOT re-announced.
     * @returns {Promise<{ accountId: string|null }>}
     */
    async linkUser(userId, apiKey) {
        let valid;
        try {
            valid = await this.validateKey(apiKey);
        } catch (error) {
            logger.warn(`${LOG_TAG} Key validation network error for user ${userId}`, { error: error.message });
            throw new Error('Could not reach Buy Me a Coffee to validate the key. Please try again.');
        }
        if (!valid) {
            throw new Error('That API key is invalid. Generate a read-only key at developers.buymeacoffee.com → Settings → API.');
        }

        // Baseline high-water-marks to the current max id per type
        let lastSupport = '0';
        let lastSubscription = '0';
        let lastExtra = '0';
        try {
            const { supporters, subscriptions, extras } = await this.fetchAll(apiKey);
            lastSupport = this._maxId(supporters);
            lastSubscription = this._maxId(subscriptions);
            lastExtra = this._maxId(extras);
        } catch (error) {
            logger.error(`${LOG_TAG} Failed to baseline marks for user ${userId}`, { error: error.message });
        }

        const accountId = this.decodeAccountId(apiKey);
        const encrypted = JSON.stringify(encryption.encrypt(apiKey));

        await pool.execute(
            `INSERT INTO bmc_user_links
                (user_id, api_key, account_id, last_support_id, last_subscription_id, last_extra_id)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                api_key = VALUES(api_key),
                account_id = VALUES(account_id),
                last_support_id = VALUES(last_support_id),
                last_subscription_id = VALUES(last_subscription_id),
                last_extra_id = VALUES(last_extra_id)`,
            [userId, encrypted, accountId, lastSupport, lastSubscription, lastExtra]
        );

        return { accountId };
    }

    async unlinkUser(userId) {
        await pool.execute('DELETE FROM bmc_announce WHERE user_id = ?', [userId]);
        await pool.execute('DELETE FROM bmc_user_links WHERE user_id = ?', [userId]);
    }

    async getLink(userId) {
        const [rows] = await pool.execute('SELECT * FROM bmc_user_links WHERE user_id = ?', [userId]);
        return rows[0] || null;
    }

    /** Decrypted API key for a user, or null if not linked / undecryptable. */
    async getApiKeyForUser(userId) {
        const link = await this.getLink(userId);
        if (!link?.api_key) return null;
        try {
            return encryption.decrypt(JSON.parse(link.api_key));
        } catch (error) {
            logger.error(`${LOG_TAG} Failed to decrypt api_key for user ${userId}`, { error: error.message });
            return null;
        }
    }

    // ─── Announce targets ────────────────────────────────────────────

    /**
     * Upsert an announce subscription for the caller in a guild. Requires the
     * user to have already linked their BMC account.
     */
    async setAnnounce(userId, guildId, channelId, addedBy) {
        const link = await this.getLink(userId);
        if (!link) {
            throw new Error('Link your Buy Me a Coffee first with /buymeacoffee link.');
        }
        await pool.execute(
            `INSERT INTO bmc_announce (user_id, guild_id, channel_id, enabled, added_by)
             VALUES (?, ?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE
                channel_id = VALUES(channel_id),
                enabled = 1,
                added_by = VALUES(added_by)`,
            [userId, guildId, channelId, addedBy || null]
        );
    }

    async stopAnnounce(userId, guildId) {
        await pool.execute(
            'UPDATE bmc_announce SET enabled = 0 WHERE user_id = ? AND guild_id = ?',
            [userId, guildId]
        );
    }

    /** Enabled announce targets for a user. */
    async getAnnounceTargets(userId) {
        const [rows] = await pool.execute(
            'SELECT * FROM bmc_announce WHERE user_id = ? AND enabled = 1',
            [userId]
        );
        return rows;
    }

    async getUserStatus(userId) {
        const link = await this.getLink(userId);
        const [targets] = await pool.execute(
            'SELECT * FROM bmc_announce WHERE user_id = ?',
            [userId]
        );
        return {
            linked: !!link,
            accountId: link?.account_id || null,
            targets,
        };
    }

    // ─── Polling / announcing ────────────────────────────────────────

    /**
     * Poll one user: announce items whose numeric id > stored last_*_id
     * (oldest→newest) to ALL of that user's enabled announce targets, then
     * advance the marks ONCE. Catches+logs its own errors; never throws.
     * @returns {Promise<number>} total announcements posted
     */
    async pollUser(userId) {
        try {
            const link = await this.getLink(userId);
            if (!link) return 0;

            const apiKey = await this.getApiKeyForUser(userId);
            if (!apiKey) {
                logger.warn(`${LOG_TAG} No usable API key for user ${userId}; skipping poll`);
                return 0;
            }

            const targets = await this.getAnnounceTargets(userId);
            if (targets.length === 0) return 0;

            const { supporters, subscriptions, extras } = await this.fetchAll(apiKey);

            let announced = 0;
            announced += await this._announceType(userId, targets, supporters, BigInt(link.last_support_id || 0), 'last_support_id');
            announced += await this._announceType(userId, targets, subscriptions, BigInt(link.last_subscription_id || 0), 'last_subscription_id');
            announced += await this._announceType(userId, targets, extras, BigInt(link.last_extra_id || 0), 'last_extra_id');

            return announced;
        } catch (error) {
            logger.error(`${LOG_TAG} pollUser failed for user ${userId}`, { error: error.message });
            return 0;
        }
    }

    /**
     * Fan out fresh items (id > lastId) for one type to every target, then
     * advance the user's high-water-mark for that type to the max id seen.
     */
    async _announceType(userId, targets, items, lastId, column) {
        const fresh = items
            .filter(it => {
                try { return BigInt(it.id) > lastId; } catch { return false; }
            })
            .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

        if (fresh.length === 0) return 0;

        let announced = 0;
        let maxSeen = lastId;

        for (const item of fresh) {
            for (const target of targets) {
                const channel = await this.findChannel(target.guild_id, target.channel_id);
                if (!channel) {
                    logger.warn(`${LOG_TAG} Channel ${target.channel_id} not found for guild ${target.guild_id} (user ${userId})`);
                    continue;
                }
                try {
                    await channel.send({ embeds: [this.buildEmbed(item, target)] });
                    announced++;
                } catch (error) {
                    logger.error(`${LOG_TAG} Failed to send announcement for user ${userId} in guild ${target.guild_id}`, { error: error.message });
                }
            }
            const idBig = BigInt(item.id);
            if (idBig > maxSeen) maxSeen = idBig;
        }

        // Advance the user's high-water-mark ONCE (even on partial send failures,
        // to avoid re-spam loops on the next cycle).
        await pool.execute(
            `UPDATE bmc_user_links SET ${column} = ? WHERE user_id = ?`,
            [maxSeen.toString(), userId]
        );

        return announced;
    }

    buildEmbed(item, target) {
        const titles = {
            supporter: '☕ New supporter!',
            subscription: '🎟️ New member!',
            extra: '🌟 New purchase!',
        };

        const showNames = target ? Number(target.show_names) !== 0 : true;
        const showAmounts = target ? Number(target.show_amounts) !== 0 : true;
        const color = (target && target.embed_color) || '#FFDD00';

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
