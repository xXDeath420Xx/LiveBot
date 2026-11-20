/*
 * Wallet services: balance, daily claim, give (with caps and audit), give limits, transactions, channel floors.
 */
import { q, T, withTx, CritterError } from './db.js';
import { formatAcorns, FLOOR_CEILING, TRANSACTIONS_DEFAULT, TRANSACTIONS_MAX } from './constants.js';
import { dailyPayout, FLOOR_COOLDOWN_MS } from './data/economy.js';
import { dailyState } from './rules/game-rules.js';
import { msUntilNextMidnight, nextLocalMidnight } from './rules/time.js';
import {
    readWallet, lockWallets, credit, debit, assertAmount, audit, lockLimits, bookAllowance, readAllowance, userLevel,
    claimCooldown, addWalletField,
} from './store.js';
import { settleCoupleBonus } from './marriage.js';
import logger from '../../utils/logger.js';

/** { balance, essence, shards, dailyAt, dailyStreak }. Creates the wallet (15,000 acorns) on first read. */
export async function getWallet(guildId, userId) {
    return readWallet(null, String(guildId), String(userId));
}

/** Admin / dashboard grant. Positive adds, negative removes (floored at 0). Returns { delta, total }. */
export async function grantCurrency(guildId, userId, amount) {
    const d = Math.trunc(Number(amount));
    if (!Number.isSafeInteger(d) || d === 0) throw new CritterError('BAD_AMOUNT', 'The amount must be a non-zero whole number.');
    const total = await withTx(conn => credit(conn, String(guildId), String(userId), d));
    return { delta: d, total };
}

/**
 * Daily claim. Always returns (never throws for the cooldown) because the couple bonus is settled after every
 * attempt, claimed or not.
 * @returns {{ claimed: boolean, cooldown?: { msLeft, readyAt }, payout?: { base, bonus, total }, streak, balance,
 *             coupleBonus: null | { amount, item, partnerId, dailies } }}
 */
export async function claimDaily(guildId, userId, { now = new Date(), rng = Math.random } = {}) {
    const g = String(guildId);
    const u = String(userId);
    const res = await withTx(async (conn) => {
        const w = await readWallet(conn, g, u, { lock: true });
        const st = dailyState(w.dailyAt, w.dailyStreak, now);
        if (st.onCooldown) return { claimed: false, cooldown: { msLeft: st.msLeft, readyAt: st.readyAt }, streak: w.dailyStreak, balance: w.balance };
        const payout = dailyPayout(st.streak);
        await q(`UPDATE ${T('wallet')} SET daily_at = ?, daily_streak = ? WHERE guild_id = ? AND user_id = ?`, [now, st.streak, g, u], conn);
        const balance = await credit(conn, g, u, payout.total);
        return { claimed: true, payout, streak: st.streak, balance };
    });
    res.coupleBonus = null;
    try {
        res.coupleBonus = await settleCoupleBonus(g, u, { now, rng });
    } catch (err) {
        logger.warn('[critters] couple bonus failed', { guildId: g, error: err.message });
    }
    return res;
}

/**
 * Give acorns. One transaction: lock both wallets (sorted), check funds, lock both limit rows, book send and
 * receive allowances, debit, credit, audit. All or nothing.
 * Errors: SELF, BAD_AMOUNT, INSUFFICIENT_FUNDS (data.balance), SEND_CAP / RECEIVE_CAP (data.remaining).
 */
export async function give(guildId, fromId, toId, amount, { receiverName = null, now = new Date() } = {}) {
    const g = String(guildId);
    const from = String(fromId);
    const to = String(toId);
    if (from === to) throw new CritterError('SELF', 'You cannot give acorns to yourself.');
    const a = assertAmount(amount);
    return withTx(async (conn) => {
        const wallets = await lockWallets(conn, g, [from, to]);
        if (wallets[from].balance < a) throw new CritterError('INSUFFICIENT_FUNDS', `You only have ${formatAcorns(wallets[from].balance)}.`, { balance: wallets[from].balance, needed: a });
        const limits = await lockLimits(conn, g, [from, to], now);
        await bookAllowance(conn, g, from, 'sent', a, { now, limits });
        await bookAllowance(conn, g, to, 'received', a, { now, limits, who: receiverName });
        if (!(await debit(conn, g, from, a))) throw new CritterError('INSUFFICIENT_FUNDS', 'You do not have enough acorns.', { needed: a });
        const toBalance = await credit(conn, g, to, a);
        await audit(conn, g, from, to, a, 'give');
        const [fw] = await q(`SELECT balance FROM ${T('wallet')} WHERE guild_id = ? AND user_id = ?`, [g, from], conn);
        return { amount: a, fromBalance: Number(fw.balance), toBalance };
    });
}

/** Today's allowance: { level, sent, received, sendCap, receiveCap, sendLeft, receiveLeft, resetsInMs, resetsAt }. */
export async function getGiveLimits(guildId, userId, { now = new Date() } = {}) {
    const a = await readAllowance(null, String(guildId), String(userId), now);
    return { ...a, resetsInMs: msUntilNextMidnight(now), resetsAt: nextLocalMidnight(now) };
}

/**
 * Newest transfers. scope: { userId } for one member's (sent or received), or { server: true } for the whole guild.
 * Rows: { tid, sender, receiver, amount, kind, at, senderIsFloor, receiverIsFloor }.
 */
export async function listTransactions(guildId, { userId = null, server = false, limit = TRANSACTIONS_DEFAULT } = {}) {
    const n = Math.max(1, Math.min(TRANSACTIONS_MAX, Math.floor(Number(limit) || TRANSACTIONS_DEFAULT)));
    const g = String(guildId);
    const rows = server || !userId
        ? await q(`SELECT * FROM ${T('ledger')} WHERE guild_id = ? ORDER BY created_at DESC, tid DESC LIMIT ?`, [g, n])
        : await q(`SELECT * FROM ${T('ledger')} WHERE guild_id = ? AND (sender = ? OR receiver = ?) ORDER BY created_at DESC, tid DESC LIMIT ?`, [g, String(userId), String(userId), n]);
    return rows.map(r => ({
        tid: Number(r.tid), sender: r.sender, receiver: r.receiver, amount: Number(r.amount), kind: r.kind, at: r.created_at,
        senderIsFloor: r.sender === '0', receiverIsFloor: r.receiver === '0',
    }));
}

/**
 * Drop acorns on this channel's floor. Claims the shared floor cooldown, books the send allowance, debits, adds to
 * the floor and audits member -> floor. Errors: COOLDOWN, INSUFFICIENT_FUNDS, FLOOR_FULL, SEND_CAP.
 */
export async function dropToFloor(guildId, userId, channelId, amount, { now = new Date() } = {}) {
    const g = String(guildId);
    const u = String(userId);
    const ch = String(channelId);
    const a = assertAmount(amount);
    return withTx(async (conn) => {
        const cd = await claimCooldown(conn, g, u, 'floor', FLOOR_COOLDOWN_MS, now);
        if (!cd.ok) throw new CritterError('COOLDOWN', 'Give it a few seconds before touching the floor again.', cd);
        const w = await readWallet(conn, g, u, { lock: true });
        if (w.balance < a) throw new CritterError('INSUFFICIENT_FUNDS', `You only have ${formatAcorns(w.balance)}.`, { balance: w.balance, needed: a });
        await q(`INSERT IGNORE INTO ${T('floors')} (guild_id, channel_id, amount) VALUES (?, ?, 0)`, [g, ch], conn);
        const [f] = await q(`SELECT amount FROM ${T('floors')} WHERE guild_id = ? AND channel_id = ? FOR UPDATE`, [g, ch], conn);
        if (Number(f.amount) + a > FLOOR_CEILING) throw new CritterError('FLOOR_FULL', 'This floor cannot hold that many acorns.');
        const limits = await lockLimits(conn, g, [u], now);
        await bookAllowance(conn, g, u, 'sent', a, { now, limits });
        await debit(conn, g, u, a);
        await q(`UPDATE ${T('floors')} SET amount = amount + ? WHERE guild_id = ? AND channel_id = ?`, [a, g, ch], conn);
        await audit(conn, g, u, '0', a, 'drop');
        const after = await readWallet(conn, g, u);
        return { amount: a, balance: after.balance };
    });
}

/**
 * Pick acorns up from this channel's floor. The cooldown is claimed in its own transaction first, so a failed
 * guess still burns it (the floor cannot be binary-searched). Errors: COOLDOWN, NOT_ON_FLOOR, RECEIVE_CAP.
 */
export async function pickupFromFloor(guildId, userId, channelId, amount, { now = new Date() } = {}) {
    const g = String(guildId);
    const u = String(userId);
    const ch = String(channelId);
    const a = assertAmount(amount);
    const cd = await withTx(conn => claimCooldown(conn, g, u, 'floor', FLOOR_COOLDOWN_MS, now));
    if (!cd.ok) throw new CritterError('COOLDOWN', 'Give it a few seconds before touching the floor again.', cd);
    return withTx(async (conn) => {
        const [f] = await q(`SELECT amount FROM ${T('floors')} WHERE guild_id = ? AND channel_id = ? FOR UPDATE`, [g, ch], conn);
        if (!f || Number(f.amount) < a) throw new CritterError('NOT_ON_FLOOR', 'There are not that many acorns lying here.');
        const limits = await lockLimits(conn, g, [u], now);
        await bookAllowance(conn, g, u, 'received', a, { now, limits, who: 'You' });
        await q(`UPDATE ${T('floors')} SET amount = amount - ? WHERE guild_id = ? AND channel_id = ?`, [a, g, ch], conn);
        const balance = await credit(conn, g, u, a);
        await audit(conn, g, '0', u, a, 'pickup');
        return { amount: a, balance };
    });
}

/** Admin helper (not shown to members): acorns on every floor in the guild. */
export async function floorTotals(guildId) {
    const rows = await q(`SELECT channel_id, amount FROM ${T('floors')} WHERE guild_id = ? AND amount > 0 ORDER BY amount DESC`, [String(guildId)]);
    return { total: rows.reduce((s, r) => s + Number(r.amount), 0), channels: rows.map(r => ({ channelId: r.channel_id, amount: Number(r.amount) })) };
}

export { userLevel, addWalletField };
