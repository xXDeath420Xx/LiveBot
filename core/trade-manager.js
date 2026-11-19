/*
 * Trades — /economy trade offer|list|history|cancel, /fun games trade (cards), the trade buttons,
 * and the dashboard Trading page.
 *
 * A trade is one `trades` row. initiator_offer / recipient_offer hold what EACH side gives
 * (core/trade-offer.js: coins, shop items from shop_inventory, cards from card_collection).
 * awaiting_id is whose answer the current terms wait for:
 *
 *   pending   posted with Accept / Counter-Edit / Decline / Cancel buttons.
 *             - the awaiting side can Accept, Decline, or Counter (new terms; awaiting flips)
 *             - the other side can Edit its proposal (awaiting stays) or Cancel it
 *   completed accepted and settled
 *   declined  turned down by the awaiting side
 *   cancelled withdrawn by the proposer, or cancelled by a server manager (dashboard)
 *   expired   no answer within 24h of the last change (jobs/economy-events-scheduler.js)
 *
 * Nothing is escrowed while pending. Acceptance settles everything in ONE transaction that locks
 * the trade row, both wallets, every shop_inventory row and every card involved (FOR UPDATE, in a
 * fixed order), re-verifies balances, quantities, tradeability and card ownership, then moves it all
 * — or nothing. Coins and shop items obey the server's economy settings (economy switched on,
 * economy_config.allow_trading); a cards-only trade does not touch the economy.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import db from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import {
    getEconomyConfig, getOrCreateUserEconomy, logTransaction, formatMoney, economyStatus, ECONOMY_DISABLED_MESSAGE,
} from './economy-manager.js';
import {
    normalizeOffer, isEmptyOffer, involvesEconomy, describeOffer, offerToText, toDashboardRow,
} from './trade-offer.js';

export const TRADE_TTL_HOURS = 24;
export const MAX_PENDING_PER_USER = 5;
export const MAX_COUNTERS = 10;

/** A refusal meant for the member (shown as-is). */
export class TradeError extends Error {}

const TRADE_COLUMNS = `id, guild_id, initiator_id, recipient_id, status, initiator_offer, recipient_offer,
    channel_id, message_id, awaiting_id, counter_count, created_at, updated_at, completed_at, expires_at,
    UNIX_TIMESTAMP(expires_at) AS expires_unix, UNIX_TIMESTAMP(created_at) AS created_unix,
    UNIX_TIMESTAMP(completed_at) AS completed_unix`;

function hydrate(row) {
    if (!row) return null;
    return { ...row, initiator_offer: normalizeOffer(row.initiator_offer), recipient_offer: normalizeOffer(row.recipient_offer) };
}

export async function getTrade(tradeId) {
    const [rows] = await db.execute(`SELECT ${TRADE_COLUMNS} FROM trades WHERE id = ?`, [tradeId]);
    return hydrate(rows[0]);
}

/** Which offer a participant gives / receives. */
function sides(trade, userId) {
    if (userId === trade.initiator_id) return { give: trade.initiator_offer, get: trade.recipient_offer, other: trade.recipient_id, isInitiator: true };
    if (userId === trade.recipient_id) return { give: trade.recipient_offer, get: trade.initiator_offer, other: trade.initiator_id, isInitiator: false };
    return null;
}

async function safeLog(...args) {
    try {
        await logTransaction(...args);
    } catch (error) {
        logger.error('[Trade] Failed to log economy transaction', { error: error.message, guildId: args[0], userId: args[1], amount: args[3] });
    }
}

/** Throws a TradeError unless coins / shop items may move in this guild. */
async function assertEconomyTradeAllowed(guildId) {
    if (await economyStatus(guildId) === 'disabled') throw new TradeError(ECONOMY_DISABLED_MESSAGE);
    const config = await getEconomyConfig(guildId);
    if (config.allow_trading !== undefined && config.allow_trading !== null && !Number(config.allow_trading)) {
        throw new TradeError('Trading coins and shop items is turned off on this server.');
    }
    return config;
}

// ─────────────────────────────── holdings ───────────────────────────────

/**
 * Check that `userId` holds everything in `offer`. With a transaction connection and lock=true the
 * rows read are locked (FOR UPDATE). Returns a list of problems (empty = fine) plus what was read.
 */
async function checkHoldings(conn, guildId, userId, offer, { lock = false, who = 'You' } = {}) {
    const o = normalizeOffer(offer);
    const forUpdate = lock ? ' FOR UPDATE' : '';
    const problems = [];
    const read = { wallet: null, items: new Map(), cards: new Map() };

    if (o.coins > 0) {
        const [w] = await conn.execute(
            `SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ?${forUpdate}`, [guildId, userId]);
        read.wallet = Number(w[0]?.wallet ?? 0);
        if (read.wallet < o.coins) problems.push(`${who} only have ${read.wallet.toLocaleString()} coins in the wallet (needs ${o.coins.toLocaleString()}).`);
    }

    if (o.items.length) {
        const ids = o.items.map(i => i.id);
        const [meta] = await conn.execute(
            `SELECT id, item_name, tradeable FROM shop_items WHERE id IN (${ids.map(() => '?').join(',')}) AND (guild_id = ? OR guild_id IS NULL)`,
            [...ids, guildId]);
        const metaById = new Map(meta.map(m => [Number(m.id), m]));
        const [inv] = await conn.execute(
            `SELECT item_id, quantity FROM shop_inventory WHERE guild_id = ? AND user_id = ? AND item_id IN (${ids.map(() => '?').join(',')}) ORDER BY item_id${forUpdate}`,
            [guildId, userId, ...ids]);
        const qtyById = new Map(inv.map(r => [Number(r.item_id), Number(r.quantity) || 0]));
        for (const it of o.items) {
            const m = metaById.get(it.id);
            if (!m) { problems.push(`Item #${it.id} isn't a shop item on this server.`); continue; }
            if (!Number(m.tradeable)) { problems.push(`${m.item_name} (ID ${it.id}) can't be traded.`); continue; }
            const have = qtyById.get(it.id) || 0;
            read.items.set(it.id, have);
            if (have < it.qty) problems.push(`${who} have ${have}x ${m.item_name} (ID ${it.id}), not ${it.qty}.`);
        }
    }

    if (o.cards.length) {
        const [cards] = await conn.execute(
            `SELECT id, user_id FROM card_collection WHERE guild_id = ? AND id IN (${o.cards.map(() => '?').join(',')}) ORDER BY id${forUpdate}`,
            [guildId, ...o.cards]);
        const owner = new Map(cards.map(c => [Number(c.id), c.user_id]));
        for (const id of o.cards) {
            read.cards.set(id, owner.get(id) || null);
            if (owner.get(id) !== userId) problems.push(`${who} don't own card #${id}.`);
        }
    }
    return { problems, read };
}

// ─────────────────────────────── create / counter ───────────────────────────────

/**
 * Create a trade. `give` = what the initiator gives, `want` = what they ask the recipient for.
 * @returns {Promise<object>} the trade row
 */
export async function createTrade({ guildId, channelId, initiatorId, recipientId, give, want }) {
    if (initiatorId === recipientId) throw new TradeError('You cannot trade with yourself.');
    const g = normalizeOffer(give);
    const w = normalizeOffer(want);
    if (isEmptyOffer(g) && isEmptyOffer(w)) throw new TradeError('Put something in the trade — what you give and/or what you want.');

    if (involvesEconomy(g, w)) {
        const config = await assertEconomyTradeAllowed(guildId);
        await getOrCreateUserEconomy(guildId, initiatorId, config);
        await getOrCreateUserEconomy(guildId, recipientId, config);
    }

    const [[pending]] = await db.execute(
        `SELECT COUNT(*) AS n FROM trades WHERE guild_id = ? AND initiator_id = ? AND status = 'pending'`,
        [guildId, initiatorId]);
    if (Number(pending?.n) >= MAX_PENDING_PER_USER) {
        throw new TradeError(`You already have ${MAX_PENDING_PER_USER} open trade offers — cancel one first (\`/economy trade list\`).`);
    }

    const mine = await checkHoldings(db, guildId, initiatorId, g, { who: 'You' });
    if (mine.problems.length) throw new TradeError(mine.problems.join('\n'));
    const theirs = await checkHoldings(db, guildId, recipientId, w, { who: 'They' });
    if (theirs.problems.length) throw new TradeError(theirs.problems.join('\n'));

    const [ins] = await db.execute(
        `INSERT INTO trades (guild_id, initiator_id, recipient_id, status, initiator_offer, recipient_offer,
                             channel_id, awaiting_id, expires_at, counter_count)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), 0)`,
        [guildId, initiatorId, recipientId, JSON.stringify(g), JSON.stringify(w), channelId, recipientId, TRADE_TTL_HOURS]);
    logger.info('[Trade] Created', { guildId, tradeId: ins.insertId, initiatorId, recipientId });
    return getTrade(ins.insertId);
}

export async function setTradeMessage(tradeId, channelId, messageId) {
    await db.execute('UPDATE trades SET channel_id = ?, message_id = ? WHERE id = ?', [channelId, messageId, tradeId]);
}

/**
 * New terms from one participant. `give` = what THEY give, `want` = what they want.
 * From the awaiting side it is a counter-offer (the other side must now answer); from the
 * proposer it revises their own proposal (still waiting on the other side).
 */
export async function counterTrade({ tradeId, userId, give, want }) {
    const trade = await getTrade(tradeId);
    if (!trade) throw new TradeError('That trade no longer exists.');
    const s = sides(trade, userId);
    if (!s) throw new TradeError('Only the two traders can change this trade.');
    if (trade.status !== 'pending') throw new TradeError(`This trade is already ${trade.status}.`);
    if (Number(trade.counter_count) >= MAX_COUNTERS) throw new TradeError(`This trade has been changed ${MAX_COUNTERS} times — decline it and start a fresh one.`);

    const g = normalizeOffer(give);
    const w = normalizeOffer(want);
    if (isEmptyOffer(g) && isEmptyOffer(w)) throw new TradeError('The trade can\'t be empty on both sides.');

    if (involvesEconomy(g, w)) {
        const config = await assertEconomyTradeAllowed(trade.guild_id);
        await getOrCreateUserEconomy(trade.guild_id, userId, config);
        await getOrCreateUserEconomy(trade.guild_id, s.other, config);
    }
    const mine = await checkHoldings(db, trade.guild_id, userId, g, { who: 'You' });
    if (mine.problems.length) throw new TradeError(mine.problems.join('\n'));
    const theirs = await checkHoldings(db, trade.guild_id, s.other, w, { who: 'They' });
    if (theirs.problems.length) throw new TradeError(theirs.problems.join('\n'));

    const initiatorOffer = s.isInitiator ? g : w;
    const recipientOffer = s.isInitiator ? w : g;
    const nextAwaiting = s.other; // whoever changed the terms waits for the other side

    const [res] = await db.execute(
        `UPDATE trades SET initiator_offer = ?, recipient_offer = ?, awaiting_id = ?, counter_count = counter_count + 1,
                           expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR)
          WHERE id = ? AND status = 'pending' AND awaiting_id = ? AND counter_count = ?`,
        [JSON.stringify(initiatorOffer), JSON.stringify(recipientOffer), nextAwaiting, TRADE_TTL_HOURS,
            tradeId, trade.awaiting_id, trade.counter_count]);
    if (res.affectedRows === 0) throw new TradeError('The trade changed while you were editing it — have another look.');
    logger.info('[Trade] Terms changed', { tradeId, by: userId, counterOffer: userId === trade.awaiting_id });
    return getTrade(tradeId);
}

// ─────────────────────────────── accept / decline / cancel ───────────────────────────────

/**
 * Accept and settle. Only the awaiting participant. One transaction for everything.
 * @param {object} opts
 * @param {import('discord.js').Guild} [opts.guild] used afterwards to move role items' roles
 */
export async function acceptTrade({ tradeId, userId, guild = null }) {
    const pre = await getTrade(tradeId);
    if (!pre) throw new TradeError('That trade no longer exists.');
    if (!sides(pre, userId)) throw new TradeError('This trade isn\'t yours to accept.');
    if (pre.status !== 'pending') throw new TradeError(`This trade is already ${pre.status}.`);
    if (pre.awaiting_id !== userId) throw new TradeError('The other trader has to answer the current terms — you can still Edit or Cancel.');

    const economy = involvesEconomy(pre.initiator_offer, pre.recipient_offer);
    let config = null;
    if (economy) {
        config = await assertEconomyTradeAllowed(pre.guild_id);
        await getOrCreateUserEconomy(pre.guild_id, pre.initiator_id, config);
        await getOrCreateUserEconomy(pre.guild_id, pre.recipient_id, config);
    }

    const guildId = pre.guild_id;
    const wallets = new Map();
    const roleMoves = []; // { itemId, roleId, from, to }
    let trade;

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [[row]] = await conn.execute(
            `SELECT ${TRADE_COLUMNS}, (expires_at IS NOT NULL AND expires_at <= NOW()) AS lapsed FROM trades WHERE id = ? FOR UPDATE`,
            [tradeId]);
        trade = hydrate(row);
        if (!trade || trade.status !== 'pending') throw new TradeError(`This trade is already ${trade?.status || 'gone'}.`);
        if (trade.awaiting_id !== userId) throw new TradeError('The terms changed — have another look before accepting.');
        if (Number(row.lapsed)) throw new TradeError('This trade offer has expired.');

        const A = trade.initiator_id;
        const B = trade.recipient_id;
        const aGives = trade.initiator_offer;
        const bGives = trade.recipient_offer;

        // Lock order: wallets (by user id), then inventory (by user, item), then cards (by id).
        if (aGives.coins > 0 || bGives.coins > 0) {
            const [w] = await conn.execute(
                'SELECT user_id, wallet FROM user_economy WHERE guild_id = ? AND user_id IN (?, ?) ORDER BY user_id FOR UPDATE',
                [guildId, A, B]);
            for (const r of w) wallets.set(r.user_id, Number(r.wallet) || 0);
        }
        const itemIds = [...new Set([...aGives.items, ...bGives.items].map(i => i.id))].sort((x, y) => x - y);
        const itemMeta = new Map();
        if (itemIds.length) {
            const [meta] = await conn.execute(
                `SELECT id, item_name, item_type, role_id, tradeable, max_per_user FROM shop_items
                  WHERE id IN (${itemIds.map(() => '?').join(',')}) AND (guild_id = ? OR guild_id IS NULL)`,
                [...itemIds, guildId]);
            for (const m of meta) itemMeta.set(Number(m.id), m);
            await conn.execute(
                `SELECT user_id, item_id, quantity FROM shop_inventory
                  WHERE guild_id = ? AND user_id IN (?, ?) AND item_id IN (${itemIds.map(() => '?').join(',')})
                  ORDER BY user_id, item_id FOR UPDATE`,
                [guildId, A, B, ...itemIds]);
        }
        const cardIds = [...new Set([...aGives.cards, ...bGives.cards])].sort((x, y) => x - y);
        if (cardIds.length) {
            await conn.execute(
                `SELECT id FROM card_collection WHERE guild_id = ? AND id IN (${cardIds.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`,
                [guildId, ...cardIds]);
        }

        const name = (id) => (id === userId ? 'You' : 'They');
        const problems = [
            ...(await checkHoldings(conn, guildId, A, aGives, { lock: true, who: name(A) })).problems,
            ...(await checkHoldings(conn, guildId, B, bGives, { lock: true, who: name(B) })).problems,
        ];
        if (problems.length) throw new TradeError(`The trade can't go through any more:\n${problems.join('\n')}`);

        // max_per_user caps also apply to items received in a trade.
        for (const [giver, receiver, offer] of [[A, B, aGives], [B, A, bGives]]) {
            for (const it of offer.items) {
                const m = itemMeta.get(it.id);
                if (!m || Number(m.max_per_user) === -1 || m.max_per_user === null) continue;
                const [[have]] = await conn.execute(
                    'SELECT quantity FROM shop_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?',
                    [guildId, receiver, it.id]);
                if ((Number(have?.quantity) || 0) + it.qty > Number(m.max_per_user)) {
                    throw new TradeError(`${m.item_name} is limited to ${m.max_per_user} per member — <@${receiver}> would go over it.`);
                }
            }
        }

        // Coins: each side's wallet changes by (received - given), guarded on covering what it gives.
        for (const [who, gives, gets] of [[A, aGives, bGives], [B, bGives, aGives]]) {
            if (!gives.coins && !gets.coins) continue;
            const [res] = await conn.execute(
                'UPDATE user_economy SET wallet = wallet - ? + ? WHERE guild_id = ? AND user_id = ? AND wallet >= ?',
                [gives.coins, gets.coins, guildId, who, gives.coins]);
            if (res.affectedRows === 0) throw new TradeError('A wallet no longer covers its side of the trade.');
        }

        // Shop items.
        for (const [giver, receiver, offer] of [[A, B, aGives], [B, A, bGives]]) {
            for (const it of offer.items) {
                const [dec] = await conn.execute(
                    'UPDATE shop_inventory SET quantity = quantity - ? WHERE guild_id = ? AND user_id = ? AND item_id = ? AND quantity >= ?',
                    [it.qty, guildId, giver, it.id, it.qty]);
                if (dec.affectedRows === 0) throw new TradeError('An item left an inventory before the trade could settle.');
                await conn.execute(
                    'DELETE FROM shop_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ? AND quantity <= 0',
                    [guildId, giver, it.id]);
                await conn.execute(
                    `INSERT INTO shop_inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
                    [guildId, receiver, it.id, it.qty]);
                const m = itemMeta.get(it.id);
                if (m?.item_type === 'role' && m.role_id) roleMoves.push({ itemId: it.id, roleId: m.role_id, from: giver, to: receiver });
            }
        }

        // Cards.
        for (const [giver, receiver, offer] of [[A, B, aGives], [B, A, bGives]]) {
            for (const id of offer.cards) {
                const [moved] = await conn.execute(
                    'UPDATE card_collection SET user_id = ? WHERE id = ? AND guild_id = ? AND user_id = ?',
                    [receiver, id, guildId, giver]);
                if (moved.affectedRows === 0) throw new TradeError(`Card #${id} changed hands before the trade could settle.`);
            }
        }

        const [done] = await conn.execute(
            `UPDATE trades SET status = 'completed', completed_at = NOW(), awaiting_id = NULL WHERE id = ? AND status = 'pending'`,
            [tradeId]);
        if (done.affectedRows === 0) throw new TradeError('This trade was settled or cancelled a moment ago.');

        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }

    // Ledger rows after commit (a logging failure must not surface after everything moved).
    if (economy) {
        const A = trade.initiator_id;
        const B = trade.recipient_id;
        const summary = (gives, gets) => `gave ${offerToText(gives)}; received ${offerToText(gets)}`;
        for (const [who, other, gives, gets] of [[A, B, trade.initiator_offer, trade.recipient_offer], [B, A, trade.recipient_offer, trade.initiator_offer]]) {
            const delta = gets.coins - gives.coins;
            const before = wallets.has(who) ? wallets.get(who) : Number((await getOrCreateUserEconomy(guildId, who, config)).wallet) - delta;
            await safeLog(guildId, who, 'trade', delta, before, before + delta,
                `Trade #${tradeId} with ${other}: ${summary(gives, gets)}`.slice(0, 1000), other,
                gives.items[0]?.id ?? gets.items[0]?.id ?? null);
        }
    }

    if (roleMoves.length && guild) await moveItemRoles(guild, guildId, roleMoves);

    logger.info('[Trade] Completed', { guildId, tradeId, initiator: trade.initiator_id, recipient: trade.recipient_id });
    return getTrade(tradeId);
}

/** Role-type shop items grant their role to the holder; move it with the item (best effort). */
async function moveItemRoles(guild, guildId, moves) {
    for (const mv of moves) {
        try {
            const role = await guild.roles.fetch(mv.roleId).catch(() => null);
            if (!role) continue;
            const receiver = await guild.members.fetch(mv.to).catch(() => null);
            if (receiver) await receiver.roles.add(role, 'Received the role item in a trade');
            const [[left]] = await db.execute(
                'SELECT quantity FROM shop_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?',
                [guildId, mv.from, mv.itemId]);
            if (!(Number(left?.quantity) > 0)) {
                const giver = await guild.members.fetch(mv.from).catch(() => null);
                if (giver) await giver.roles.remove(role, 'Traded away the role item');
            }
        } catch (error) {
            logger.warn('[Trade] Could not move a role item\'s role', { guildId, roleId: mv.roleId, error: error.message });
        }
    }
}

/**
 * Turn down / withdraw. The awaiting side declines; the other side cancels.
 */
export async function closeTrade({ tradeId, userId }) {
    const trade = await getTrade(tradeId);
    if (!trade) throw new TradeError('That trade no longer exists.');
    if (!sides(trade, userId)) throw new TradeError('This trade isn\'t yours.');
    if (trade.status !== 'pending') throw new TradeError(`This trade is already ${trade.status}.`);
    const status = trade.awaiting_id === userId ? 'declined' : 'cancelled';
    const [res] = await db.execute(
        `UPDATE trades SET status = ?, awaiting_id = NULL WHERE id = ? AND status = 'pending'`, [status, tradeId]);
    if (res.affectedRows === 0) throw new TradeError('This trade was settled or closed a moment ago.');
    logger.info('[Trade] Closed', { tradeId, by: userId, status });
    return getTrade(tradeId);
}

/** Dashboard: a server manager cancels a pending trade (nothing is escrowed, so nothing to return). */
export async function cancelTradeByAdmin(guildId, tradeId, adminId = null) {
    const [res] = await db.execute(
        `UPDATE trades SET status = 'cancelled', awaiting_id = NULL WHERE id = ? AND guild_id = ? AND status = 'pending'`,
        [tradeId, guildId]);
    if (res.affectedRows === 0) return false;
    logger.info('[Trade] Cancelled from the dashboard', { guildId, tradeId, adminId });
    const trade = await getTrade(tradeId);
    await refreshTradeMessage(trade, null, 'Cancelled by a server manager.');
    return true;
}

/** Expire pending trades past expires_at and update their messages. */
export async function expireDueTrades(limit = 100) {
    let due;
    try {
        [due] = await db.execute(
            `SELECT id FROM trades WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= NOW()
              ORDER BY expires_at LIMIT ${Math.max(1, Math.floor(limit))}`);
    } catch (error) {
        logger.error('[Trade] Could not read expired trades', { error: error.message });
        return 0;
    }
    let n = 0;
    for (const { id } of due) {
        try {
            const [res] = await db.execute(
                `UPDATE trades SET status = 'expired', awaiting_id = NULL WHERE id = ? AND status = 'pending' AND expires_at <= NOW()`, [id]);
            if (res.affectedRows === 1) {
                n++;
                await refreshTradeMessage(await getTrade(id));
            }
        } catch (error) {
            logger.error('[Trade] Expiring a trade failed', { tradeId: id, error: error.message });
        }
    }
    if (n) logger.info(`[Trade] Expired ${n} trade offer(s)`);
    return n;
}

// ─────────────────────────────── queries ───────────────────────────────

export async function listOpenTrades(guildId, userId) {
    const [rows] = await db.execute(
        `SELECT ${TRADE_COLUMNS} FROM trades
          WHERE guild_id = ? AND status = 'pending' AND (initiator_id = ? OR recipient_id = ?)
          ORDER BY id DESC LIMIT 25`,
        [guildId, userId, userId]);
    return rows.map(hydrate);
}

export async function listTradeHistory(guildId, userId, limit = 10) {
    const [rows] = await db.execute(
        `SELECT ${TRADE_COLUMNS} FROM trades
          WHERE guild_id = ? AND status <> 'pending' AND (initiator_id = ? OR recipient_id = ?)
          ORDER BY COALESCE(completed_at, updated_at, created_at) DESC LIMIT ${Math.max(1, Math.min(25, Math.floor(limit)))}`,
        [guildId, userId, userId]);
    return rows.map(hydrate);
}

/** Shop item / card names for a set of offers. */
export async function loadLabels(guildId, offers) {
    const itemIds = [...new Set(offers.flatMap(o => normalizeOffer(o).items.map(i => i.id)))];
    const cardIds = [...new Set(offers.flatMap(o => normalizeOffer(o).cards))];
    const items = new Map();
    const cards = new Map();
    if (itemIds.length) {
        const [rows] = await db.execute(
            `SELECT id, item_name, item_emoji FROM shop_items WHERE id IN (${itemIds.map(() => '?').join(',')})`, itemIds);
        for (const r of rows) items.set(Number(r.id), { name: r.item_name, emoji: r.item_emoji });
    }
    if (cardIds.length) {
        const [rows] = await db.execute(
            `SELECT id, card_name, rarity, power FROM card_collection WHERE guild_id = ? AND id IN (${cardIds.map(() => '?').join(',')})`,
            [guildId, ...cardIds]);
        for (const r of rows) cards.set(Number(r.id), { name: r.card_name, rarity: r.rarity, power: r.power });
    }
    return { items, cards };
}

/** Autocomplete: a member's tradeable shop items. */
export async function tradeableInventory(guildId, userId, search = '') {
    const [rows] = await db.execute(
        `SELECT si.id, si.item_name, si.item_emoji, inv.quantity
           FROM shop_inventory inv JOIN shop_items si ON si.id = inv.item_id
          WHERE inv.guild_id = ? AND inv.user_id = ? AND inv.quantity > 0 AND si.tradeable = 1 AND si.item_name LIKE ?
          ORDER BY si.item_name LIMIT 25`,
        [guildId, userId, `%${String(search).replace(/[%_\\]/g, m => '\\' + m)}%`]);
    return rows;
}

// ─────────────────────────────── presentation ───────────────────────────────

function findChannel(guildId, channelId, client = null) {
    if (!channelId) return null;
    const candidates = [];
    if (client) candidates.push(client);
    const manager = global.botManager;
    if (manager?.getClientForGuild) {
        const c = manager.getClientForGuild(guildId);
        if (c) candidates.push(c);
    }
    if (manager?.clients) for (const [, c] of manager.clients) candidates.push(c);
    for (const c of candidates) {
        const channel = c?.guilds?.cache?.get(guildId)?.channels?.cache?.get(channelId);
        if (channel) return channel;
    }
    return null;
}

const STATUS_TEXT = {
    pending: '⏳ Pending',
    completed: '✅ Completed',
    declined: '❌ Declined',
    cancelled: '🚫 Cancelled',
    expired: '⌛ Expired',
    accepted: '✅ Accepted',
};

export async function tradeEmbed(trade, note = null) {
    const config = involvesEconomy(trade.initiator_offer, trade.recipient_offer) ? await getEconomyConfig(trade.guild_id) : null;
    const labels = await loadLabels(trade.guild_id, [trade.initiator_offer, trade.recipient_offer]);
    const ctx = { ...labels, money: config ? (n => formatMoney(n, config)) : undefined };
    const fmt = (who, offer) => {
        const lines = describeOffer(offer, ctx).map(l => `• ${l}`);
        return [`<@${who}>`, ...(lines.length ? lines : ['*nothing*'])].join('\n').slice(0, 1024);
    };

    const color = trade.status === 'pending' ? 'warning'
        : trade.status === 'completed' ? 'success' : 'danger';
    const embed = new EmbedBuilder()
        .setColor(themeColor(trade.guild_id, color))
        .setTitle(`🤝 Trade #${trade.id}`)
        .setDescription(`<@${trade.initiator_id}> ⇄ <@${trade.recipient_id}>`)
        .addFields(
            { name: '📤 Gives', value: fmt(trade.initiator_id, trade.initiator_offer), inline: true },
            { name: '📥 Gives in return', value: fmt(trade.recipient_id, trade.recipient_offer), inline: true },
            { name: 'Status', value: STATUS_TEXT[trade.status] || trade.status, inline: false },
        );
    if (trade.status === 'pending') {
        embed.addFields(
            { name: 'Waiting on', value: `<@${trade.awaiting_id}> — Accept, Counter or Decline`, inline: true },
            { name: 'Expires', value: trade.expires_unix ? `<t:${Number(trade.expires_unix)}:R>` : '—', inline: true },
        );
    }
    if (note) embed.addFields({ name: 'Note', value: String(note).slice(0, 1024) });
    embed.setFooter({ text: `Changes: ${Number(trade.counter_count) || 0}/${MAX_COUNTERS} • items: /economy shop inventory • cards: /fun games collection` });
    return embed;
}

export function tradeComponents(trade) {
    if (trade.status !== 'pending') return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`trade:acc:${trade.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`trade:ctr:${trade.id}`).setLabel('Counter / Edit').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`trade:dec:${trade.id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`trade:can:${trade.id}`).setLabel('Cancel offer').setStyle(ButtonStyle.Secondary),
    )];
}

/** Redraw a trade's message (best effort). */
export async function refreshTradeMessage(trade, client = null, note = null) {
    if (!trade?.message_id) return false;
    const channel = findChannel(trade.guild_id, trade.channel_id, client);
    if (!channel) return false;
    try {
        const message = await channel.messages.fetch(trade.message_id);
        await message.edit({ embeds: [await tradeEmbed(trade, note)], components: tradeComponents(trade) });
        return true;
    } catch (error) {
        logger.warn('[Trade] Could not update the trade message', { tradeId: trade.id, error: error.message });
        return false;
    }
}

// ─────────────────────────────── dashboard ───────────────────────────────

/**
 * Everything dashboard/views/partials/manage/trading.ejs reads: activeTrades, tradeHistory, tradeStats.
 * Rows come from toDashboardRow (core/trade-offer.js); names resolve from the bot's caches only.
 */
export async function loadTradingPageData(guildId, guild = null) {
    const [active] = await db.execute(
        `SELECT id, initiator_id, recipient_id, status, initiator_offer, recipient_offer, awaiting_id,
                created_at, updated_at, completed_at, expires_at
           FROM trades WHERE guild_id = ? AND status = 'pending'
          ORDER BY created_at DESC LIMIT 100`, [guildId]);
    const [history] = await db.execute(
        `SELECT id, initiator_id, recipient_id, status, initiator_offer, recipient_offer, awaiting_id,
                created_at, updated_at, completed_at, expires_at
           FROM trades WHERE guild_id = ? AND status <> 'pending'
          ORDER BY COALESCE(completed_at, updated_at, created_at) DESC LIMIT 50`, [guildId]);
    const [[stats]] = await db.execute(
        `SELECT COALESCE(SUM(status = 'pending'), 0) AS active_trades,
                COALESCE(SUM(status = 'completed'), 0) AS completed_trades,
                COALESCE(SUM(status IN ('cancelled','declined','expired')), 0) AS cancelled_trades
           FROM trades WHERE guild_id = ?`, [guildId]);

    const all = [...active, ...history];
    const labels = await loadLabels(guildId, all.flatMap(r => [r.initiator_offer, r.recipient_offer]));
    const label = (offer) => describeOffer(offer, labels);
    const nameOf = (id) => {
        const m = guild?.members?.cache?.get(String(id));
        if (m) return m.displayName;
        const u = guild?.client?.users?.cache?.get(String(id));
        return u ? (u.globalName || u.username) : null;
    };
    const shape = (r) => {
        const row = toDashboardRow(r, label);
        return { ...row, initiator_name: nameOf(row.initiator_id), partner_name: nameOf(row.partner_id) };
    };
    return {
        activeTrades: active.map(shape),
        tradeHistory: history.map(shape),
        tradeStats: {
            active_trades: Number(stats?.active_trades) || 0,
            completed_trades: Number(stats?.completed_trades) || 0,
            cancelled_trades: Number(stats?.cancelled_trades) || 0,
        },
    };
}

export default {
    TradeError, TRADE_TTL_HOURS, MAX_PENDING_PER_USER, MAX_COUNTERS,
    getTrade, createTrade, setTradeMessage, counterTrade, acceptTrade, closeTrade, cancelTradeByAdmin, expireDueTrades,
    listOpenTrades, listTradeHistory, loadLabels, tradeableInventory, tradeEmbed, tradeComponents, refreshTradeMessage,
    loadTradingPageData,
};
