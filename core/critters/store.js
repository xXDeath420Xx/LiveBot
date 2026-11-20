/*
 * Shared storage primitives used inside transactions: wallet, boxes, cooldowns, the ledger and give allowances.
 * Every function takes a connection (from withTx) or null for the pool.
 */
import { q, T, CritterError } from './db.js';
import { STARTING_BALANCE, EPOCH, formatAcorns } from './constants.js';
import { sendCap, receiveCap } from './data/economy.js';
import { isBeforeToday } from './rules/time.js';

const num = (v) => Number(v) || 0;

export function assertAmount(amount, { min = 1 } = {}) {
    const n = Number(amount);
    if (!Number.isSafeInteger(n) || n < min) throw new CritterError('BAD_AMOUNT', `The amount must be a whole number of at least ${min}.`, { min });
    return n;
}

/* ----------------------------------------------------------------------------------------------- wallet */

export async function ensureWallet(conn, g, u) {
    await q(`INSERT IGNORE INTO ${T('wallet')} (guild_id, user_id, balance) VALUES (?, ?, ?)`, [g, u, STARTING_BALANCE], conn);
}

export function walletFromRow(r) {
    return {
        balance: num(r?.balance ?? STARTING_BALANCE), essence: num(r?.essence), shards: num(r?.shards),
        dailyAt: r?.daily_at || null, dailyStreak: num(r?.daily_streak),
    };
}

export async function readWallet(conn, g, u, { lock = false } = {}) {
    await ensureWallet(conn, g, u);
    const [row] = await q(`SELECT * FROM ${T('wallet')} WHERE guild_id = ? AND user_id = ?${lock ? ' FOR UPDATE' : ''}`, [g, u], conn);
    return walletFromRow(row);
}

/** Lock several wallets in a fixed order (sorted ids) so opposite transfers cannot deadlock. */
export async function lockWallets(conn, g, ids) {
    const sorted = [...new Set(ids.map(String))].sort();
    const out = {};
    for (const id of sorted) out[id] = await readWallet(conn, g, id, { lock: true });
    return out;
}

/** Add acorns (amount >= 0) or take them away clamped at 0 (amount < 0). Returns the new balance. */
export async function credit(conn, g, u, amount) {
    const a = Math.trunc(Number(amount) || 0);
    await ensureWallet(conn, g, u);
    if (a >= 0) {
        await q(`UPDATE ${T('wallet')} SET balance = balance + ? WHERE guild_id = ? AND user_id = ?`, [a, g, u], conn);
    } else {
        await q(`UPDATE ${T('wallet')} SET balance = IF(balance >= ?, balance - ?, 0) WHERE guild_id = ? AND user_id = ?`, [-a, -a, g, u], conn);
    }
    const [row] = await q(`SELECT balance FROM ${T('wallet')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
    return num(row?.balance);
}

/** Guarded debit: false (and no change) when the balance is short. */
export async function debit(conn, g, u, amount) {
    const a = Math.trunc(Number(amount) || 0);
    if (a <= 0) return true;
    await ensureWallet(conn, g, u);
    const r = await q(`UPDATE ${T('wallet')} SET balance = balance - ? WHERE guild_id = ? AND user_id = ? AND balance >= ?`, [a, g, u, a], conn);
    return r.affectedRows === 1;
}

export async function debitOrThrow(conn, g, u, amount) {
    if (!(await debit(conn, g, u, amount))) {
        const w = await readWallet(conn, g, u);
        throw new CritterError('INSUFFICIENT_FUNDS', `You need ${formatAcorns(amount)} but only have ${formatAcorns(w.balance)}.`, { needed: amount, balance: w.balance });
    }
}

/** Add (or remove, clamped at 0) shards or essence. Returns the new value. */
export async function addWalletField(conn, g, u, field, delta) {
    if (!['shards', 'essence'].includes(field)) throw new Error('bad field');
    const d = Math.trunc(Number(delta) || 0);
    await ensureWallet(conn, g, u);
    if (d >= 0) await q(`UPDATE ${T('wallet')} SET ${field} = ${field} + ? WHERE guild_id = ? AND user_id = ?`, [d, g, u], conn);
    else await q(`UPDATE ${T('wallet')} SET ${field} = IF(${field} >= ?, ${field} - ?, 0) WHERE guild_id = ? AND user_id = ?`, [-d, -d, g, u], conn);
    const [row] = await q(`SELECT ${field} AS v FROM ${T('wallet')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
    return num(row?.v);
}

/** Guarded spend of shards or essence: false when short. */
export async function spendWalletField(conn, g, u, field, amount) {
    if (!['shards', 'essence'].includes(field)) throw new Error('bad field');
    await ensureWallet(conn, g, u);
    const r = await q(`UPDATE ${T('wallet')} SET ${field} = ${field} - ? WHERE guild_id = ? AND user_id = ? AND ${field} >= ?`, [amount, g, u, amount], conn);
    return r.affectedRows === 1;
}

/* ----------------------------------------------------------------------------------------------- boxes */

/** Lootbox / crate row. New rows get epoch drop windows so they never eat a day's guaranteed first drop. */
export async function ensureBoxes(conn, g, u) {
    await q(`INSERT IGNORE INTO ${T('boxes')} (guild_id, user_id, lootbox_window, crate_window) VALUES (?, ?, ?, ?)`, [g, u, EPOCH, EPOCH], conn);
}

export async function readBoxes(conn, g, u, { lock = false } = {}) {
    await ensureBoxes(conn, g, u);
    const [r] = await q(`SELECT * FROM ${T('boxes')} WHERE guild_id = ? AND user_id = ?${lock ? ' FOR UPDATE' : ''}`, [g, u], conn);
    return {
        lootboxes: num(r?.lootboxes), lootboxDrops: num(r?.lootbox_drops), lootboxWindow: r?.lootbox_window || null,
        crates: num(r?.crates), crateDrops: num(r?.crate_drops), crateWindow: r?.crate_window || null,
    };
}

export async function addBoxes(conn, g, u, kind, delta) {
    const col = kind === 'lootbox' ? 'lootboxes' : kind === 'crate' ? 'crates' : null;
    if (!col) throw new Error('bad box kind');
    const d = Math.trunc(Number(delta) || 0);
    await ensureBoxes(conn, g, u);
    if (d >= 0) await q(`UPDATE ${T('boxes')} SET ${col} = ${col} + ? WHERE guild_id = ? AND user_id = ?`, [d, g, u], conn);
    else await q(`UPDATE ${T('boxes')} SET ${col} = IF(${col} >= ?, ${col} - ?, 0) WHERE guild_id = ? AND user_id = ?`, [-d, -d, g, u], conn);
    const [r] = await q(`SELECT ${col} AS v FROM ${T('boxes')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
    return num(r?.v);
}

/** Guarded take of n boxes. Returns the count left, or null when short. */
export async function takeBoxes(conn, g, u, kind, n) {
    const col = kind === 'lootbox' ? 'lootboxes' : 'crates';
    await ensureBoxes(conn, g, u);
    const r = await q(`UPDATE ${T('boxes')} SET ${col} = ${col} - ? WHERE guild_id = ? AND user_id = ? AND ${col} >= ?`, [n, g, u, n], conn);
    if (r.affectedRows !== 1) return null;
    const [row] = await q(`SELECT ${col} AS v FROM ${T('boxes')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
    return num(row?.v);
}

/* ----------------------------------------------------------------------------------------------- cooldowns */

/**
 * Claim a cooldown inside a transaction: locks the row, refuses while it is running, otherwise stamps `now`.
 * @returns {{ ok: true } | { ok: false, msLeft, readyAt }}
 */
export async function claimCooldown(conn, g, u, action, ms, now = new Date()) {
    await q(`INSERT IGNORE INTO ${T('cooldowns')} (guild_id, user_id, action, used_at) VALUES (?, ?, ?, ?)`, [g, u, action, EPOCH], conn);
    const [row] = await q(`SELECT used_at FROM ${T('cooldowns')} WHERE guild_id = ? AND user_id = ? AND action = ? FOR UPDATE`, [g, u, action], conn);
    const last = row?.used_at ? new Date(row.used_at).getTime() : 0;
    if (now.getTime() - last < ms) {
        const readyAt = new Date(last + ms);
        return { ok: false, msLeft: readyAt.getTime() - now.getTime(), readyAt };
    }
    await q(`UPDATE ${T('cooldowns')} SET used_at = ? WHERE guild_id = ? AND user_id = ? AND action = ?`, [now, g, u, action], conn);
    return { ok: true };
}

export async function readCooldown(conn, g, u, action) {
    const [row] = await q(`SELECT used_at FROM ${T('cooldowns')} WHERE guild_id = ? AND user_id = ? AND action = ?`, [g, u, action], conn);
    return row?.used_at && new Date(row.used_at).getTime() > EPOCH.getTime() ? new Date(row.used_at) : null;
}

export async function setCooldown(conn, g, u, action, at) {
    await q(`INSERT INTO ${T('cooldowns')} (guild_id, user_id, action, used_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE used_at = VALUES(used_at)`, [g, u, action, at], conn);
}

/* ----------------------------------------------------------------------------------------------- ledger */

/** One audit row per movement. sender / receiver '0' = the channel floor. kind: give | drop | pickup | bet. */
export async function audit(conn, g, sender, receiver, amount, kind) {
    await q(`INSERT INTO ${T('ledger')} (guild_id, sender, receiver, amount, kind, created_at) VALUES (?, ?, ?, ?, ?, NOW(6))`,
        [g, String(sender), String(receiver), amount, kind], conn);
}

/* ----------------------------------------------------------------------------------------------- give allowances */

/** Highest server level for the member (0 when none or on error). The one read from the leveling system. */
export async function userLevel(conn, g, u) {
    try {
        const [row] = await q('SELECT MAX(level) AS lvl FROM user_levels WHERE guild_id = ? AND user_id = ?', [g, u], conn);
        return Math.max(0, num(row?.lvl));
    } catch {
        return 0;
    }
}

/** Lock allowance rows for several members (sorted). Returns { id: { sent, received, stale } }. */
export async function lockLimits(conn, g, ids, now = new Date()) {
    const out = {};
    for (const id of [...new Set(ids.map(String))].sort()) {
        await q(`INSERT IGNORE INTO ${T('give_limits')} (guild_id, user_id, sent, received, window_at) VALUES (?, ?, 0, 0, ?)`, [g, id, EPOCH], conn);
        const [r] = await q(`SELECT sent, received, window_at FROM ${T('give_limits')} WHERE guild_id = ? AND user_id = ? FOR UPDATE`, [g, id], conn);
        const stale = isBeforeToday(r?.window_at, now);
        out[id] = { sent: stale ? 0 : num(r?.sent), received: stale ? 0 : num(r?.received), stale };
    }
    return out;
}

/** Read-only allowance view for one member. */
export async function readAllowance(conn, g, u, now = new Date()) {
    const level = await userLevel(conn, g, u);
    const [r] = await q(`SELECT sent, received, window_at FROM ${T('give_limits')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
    const stale = isBeforeToday(r?.window_at, now);
    const sent = stale ? 0 : num(r?.sent);
    const received = stale ? 0 : num(r?.received);
    const sCap = sendCap(level);
    const rCap = receiveCap(level);
    return { level, sent, received, sendCap: sCap, receiveCap: rCap, sendLeft: Math.max(0, sCap - sent), receiveLeft: Math.max(0, rCap - received) };
}

/**
 * Book `amount` against a member's send or receive allowance. The rows must already be locked (lockLimits).
 * With enforce on, a booking over the cap throws (code SEND_CAP / RECEIVE_CAP) and changes nothing.
 */
export async function bookAllowance(conn, g, u, field, amount, { enforce = true, now = new Date(), limits = null, level = null, who = null } = {}) {
    const lim = limits?.[String(u)] || (await lockLimits(conn, g, [u], now))[String(u)];
    const lvl = level ?? await userLevel(conn, g, u);
    const cap = field === 'sent' ? sendCap(lvl) : receiveCap(lvl);
    const used = field === 'sent' ? lim.sent : lim.received;
    if (enforce && used + amount > cap) {
        const left = Math.max(0, cap - used);
        if (field === 'sent') throw new CritterError('SEND_CAP', `You can only send ${formatAcorns(left)} more today.`, { remaining: left, cap });
        throw new CritterError('RECEIVE_CAP', `${who ? `${who} ` : 'They '}can only receive ${formatAcorns(left)} more today.`, { remaining: left, cap, userId: String(u) });
    }
    if (lim.stale) {
        await q(`UPDATE ${T('give_limits')} SET sent = ?, received = ?, window_at = ? WHERE guild_id = ? AND user_id = ?`,
            [field === 'sent' ? amount : 0, field === 'received' ? amount : 0, now, g, u], conn);
        lim.stale = false;
        lim.sent = field === 'sent' ? amount : 0;
        lim.received = field === 'received' ? amount : 0;
    } else {
        await q(`UPDATE ${T('give_limits')} SET ${field} = ${field} + ? WHERE guild_id = ? AND user_id = ?`, [amount, g, u], conn);
        if (field === 'sent') lim.sent += amount; else lim.received += amount;
    }
    return { cap, used: used + amount };
}
