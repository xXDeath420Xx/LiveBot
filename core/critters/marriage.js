/*
 * Rings and marriage (per server). A pending proposal holds the proposer's ring until it is answered.
 */
import { q, T, withTx, CritterError } from './db.js';
import { formatAcorns, DAY_MS } from './constants.js';
import { RINGS, ringById, ringSellPrice, coupleBonusAmount } from './data/economy.js';
import { COMPLIMENTS, BOT_MARRIAGE_REFUSAL, pick } from './data/text.js';
import { orderPair } from './rules/misc-rules.js';
import { lastLocalMidnight, isBeforeToday } from './rules/time.js';
import { credit, debit, addBoxes } from './store.js';

const ringOrThrow = (id) => {
    const r = ringById(id);
    if (!r) throw new CritterError('UNKNOWN_RING', `There is no ring ${id}. Rings are numbered 1 to ${RINGS.length}.`);
    return r;
};

async function ringCount(conn, g, u, rid, { lock = false } = {}) {
    const [r] = await q(`SELECT qty FROM ${T('rings')} WHERE guild_id = ? AND user_id = ? AND ring_id = ?${lock ? ' FOR UPDATE' : ''}`, [g, u, rid], conn);
    return Number(r?.qty) || 0;
}

async function addRing(conn, g, u, rid, n = 1) {
    await q(`INSERT INTO ${T('rings')} (guild_id, user_id, ring_id, qty) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty)`, [g, u, rid, n], conn);
}

async function takeRing(conn, g, u, rid) {
    const r = await q(`UPDATE ${T('rings')} SET qty = qty - 1 WHERE guild_id = ? AND user_id = ? AND ring_id = ? AND qty > 0`, [g, u, rid], conn);
    return r.affectedRows === 1;
}

export async function marriageOf(conn, g, u, { lock = false } = {}) {
    const [m] = await q(`SELECT * FROM ${T('marriages')} WHERE guild_id = ? AND (user1 = ? OR user2 = ?) LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [g, u, u], conn);
    if (!m) return null;
    return { user1: m.user1, user2: m.user2, partnerId: m.user1 === u ? m.user2 : m.user1, ringId: Number(m.ring_id), marriedAt: m.married_at, dailies: Number(m.dailies), bonusAt: m.bonus_at };
}

async function proposalsOf(conn, g, u, { lock = false } = {}) {
    const sfx = lock ? ' FOR UPDATE' : '';
    const [outgoing] = await q(`SELECT * FROM ${T('proposals')} WHERE guild_id = ? AND sender = ?${sfx}`, [g, u], conn);
    const [incoming] = await q(`SELECT * FROM ${T('proposals')} WHERE guild_id = ? AND receiver = ?${sfx}`, [g, u], conn);
    const shape = (p) => p && { sender: p.sender, receiver: p.receiver, ringId: Number(p.ring_id), channelId: p.channel_id, createdAt: p.created_at };
    return { outgoing: shape(outgoing), incoming: shape(incoming) };
}

/* ----------------------------------------------------------------------------------------------- rings */

export function ringCatalog() {
    return RINGS.map(r => ({ ...r, sellPrice: ringSellPrice(r) }));
}

export async function buyRing(guildId, userId, ringId) {
    const g = String(guildId); const u = String(userId);
    const ring = ringOrThrow(ringId);
    return withTx(async (conn) => {
        if (!(await debit(conn, g, u, ring.price))) throw new CritterError('INSUFFICIENT_FUNDS', `${ring.name} costs ${formatAcorns(ring.price)}.`, { needed: ring.price });
        await addRing(conn, g, u, ring.id);
        const [w] = await q(`SELECT balance FROM ${T('wallet')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
        return { ring, owned: await ringCount(conn, g, u, ring.id), balance: Number(w.balance) };
    });
}

export async function sellRing(guildId, userId, ringId) {
    const g = String(guildId); const u = String(userId);
    const ring = ringOrThrow(ringId);
    return withTx(async (conn) => {
        if (!(await takeRing(conn, g, u, ring.id))) throw new CritterError('NO_RING', `You do not have a ${ring.name}.`);
        const price = ringSellPrice(ring);
        const balance = await credit(conn, g, u, price);
        return { ring, price, owned: await ringCount(conn, g, u, ring.id), balance };
    });
}

export async function ringInventory(guildId, userId) {
    const rows = await q(`SELECT ring_id, qty FROM ${T('rings')} WHERE guild_id = ? AND user_id = ? AND qty > 0 ORDER BY ring_id`, [String(guildId), String(userId)]);
    return rows.map(r => { const ring = ringById(r.ring_id); return ring && { ring, qty: Number(r.qty), sellPrice: ringSellPrice(ring) }; }).filter(Boolean);
}

/* ----------------------------------------------------------------------------------------------- proposals */

/**
 * Propose (takes your ring into the proposal). If you are already married to the target this is a ring change:
 * the surface should confirm, then call changeRing. Returns { kind: 'proposal', proposal } or
 * { kind: 'ring-change', currentRing, newRing } (nothing changed yet).
 * Errors: BOT, SELF, UNKNOWN_RING, SAME_RING, NO_RING, YOU_MARRIED, THEY_MARRIED, PENDING.
 */
export async function propose(guildId, userId, targetId, ringId, { channelId = null, targetIsBot = false, targetIsThisBot = false } = {}) {
    const g = String(guildId); const u = String(userId); const t = String(targetId);
    if (targetIsThisBot) throw new CritterError('BOT', BOT_MARRIAGE_REFUSAL);
    if (targetIsBot) throw new CritterError('BOT', 'Bots cannot get married.');
    if (u === t) throw new CritterError('SELF', 'You cannot propose to yourself.');
    const ring = ringOrThrow(ringId);
    return withTx(async (conn) => {
        const mine = await marriageOf(conn, g, u, { lock: true });
        if (mine && mine.partnerId === t) {
            if (mine.ringId === ring.id) throw new CritterError('SAME_RING', 'That is already your ring.');
            if ((await ringCount(conn, g, u, ring.id)) < 1) throw new CritterError('NO_RING', `You do not have a ${ring.name}. Buy one first.`);
            return { kind: 'ring-change', currentRing: ringById(mine.ringId), newRing: ring };
        }
        if (mine) throw new CritterError('YOU_MARRIED', 'You are already married.');
        if (await marriageOf(conn, g, t, { lock: true })) throw new CritterError('THEY_MARRIED', 'They are already married.');
        const a = await proposalsOf(conn, g, u, { lock: true });
        const b = await proposalsOf(conn, g, t, { lock: true });
        if (a.outgoing || a.incoming || b.outgoing || b.incoming) throw new CritterError('PENDING', 'One of you already has a proposal waiting for an answer.');
        if (!(await takeRing(conn, g, u, ring.id))) throw new CritterError('NO_RING', `You do not have a ${ring.name}. Buy one first.`);
        await q(`INSERT INTO ${T('proposals')} (guild_id, sender, receiver, ring_id, channel_id, created_at) VALUES (?, ?, ?, ?, ?, NOW())`, [g, u, t, ring.id, channelId], conn);
        return { kind: 'proposal', proposal: { sender: u, receiver: t, ring } };
    });
}

/** Confirmed ring change between partners: the old ring breaks, the new one is used up. */
export async function changeRing(guildId, userId, partnerId, ringId) {
    const g = String(guildId); const u = String(userId);
    const ring = ringOrThrow(ringId);
    return withTx(async (conn) => {
        const m = await marriageOf(conn, g, u, { lock: true });
        if (!m || m.partnerId !== String(partnerId)) throw new CritterError('NOT_MARRIED', 'You are not married to them any more.');
        if (m.ringId === ring.id) throw new CritterError('SAME_RING', 'That is already your ring.');
        if (!(await takeRing(conn, g, u, ring.id))) throw new CritterError('NO_RING', `You do not have a ${ring.name}.`);
        await q(`UPDATE ${T('marriages')} SET ring_id = ? WHERE guild_id = ? AND user1 = ? AND user2 = ?`, [ring.id, g, m.user1, m.user2], conn);
        return { oldRing: ringById(m.ringId), newRing: ring };
    });
}

/** Accept the proposal made to you. Errors: NO_PROPOSAL, FELL_THROUGH (ring returned to the proposer). */
export async function acceptProposal(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    const out = await withTx(async (conn) => {
        const { incoming } = await proposalsOf(conn, g, u, { lock: true });
        if (!incoming) throw new CritterError('NO_PROPOSAL', 'Nobody has proposed to you.');
        await q(`DELETE FROM ${T('proposals')} WHERE guild_id = ? AND sender = ?`, [g, incoming.sender], conn);
        if ((await marriageOf(conn, g, u, { lock: true })) || (await marriageOf(conn, g, incoming.sender, { lock: true }))) {
            await addRing(conn, g, incoming.sender, incoming.ringId);
            return { fellThrough: true, proposerId: incoming.sender };
        }
        const [user1, user2] = orderPair(incoming.sender, u);
        await q(`INSERT INTO ${T('marriages')} (guild_id, user1, user2, ring_id, married_at, dailies) VALUES (?, ?, ?, ?, NOW(), 0)`, [g, user1, user2, incoming.ringId], conn);
        return { fellThrough: false, partnerId: incoming.sender, ring: ringById(incoming.ringId) };
    });
    if (out.fellThrough) throw new CritterError('FELL_THROUGH', 'That proposal fell through: one of you got married in the meantime. The ring went back.', { proposerId: out.proposerId });
    return out;
}

/** Decline a proposal to you, or withdraw your own. The ring goes back to the proposer. Error: NO_PROPOSAL. */
export async function declineProposal(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        const { incoming, outgoing } = await proposalsOf(conn, g, u, { lock: true });
        const p = incoming || outgoing;
        if (!p) throw new CritterError('NO_PROPOSAL', 'There is no proposal to answer or withdraw.');
        await q(`DELETE FROM ${T('proposals')} WHERE guild_id = ? AND sender = ?`, [g, p.sender], conn);
        await addRing(conn, g, p.sender, p.ringId);
        return { kind: incoming ? 'declined' : 'withdrawn', sender: p.sender, receiver: p.receiver, ring: ringById(p.ringId) };
    });
}

/** Divorce (the surface confirms first). The ring is gone. Error: NOT_MARRIED. */
export async function divorce(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        const m = await marriageOf(conn, g, u, { lock: true });
        if (!m) throw new CritterError('NOT_MARRIED', 'You are not married.');
        await q(`DELETE FROM ${T('marriages')} WHERE guild_id = ? AND user1 = ? AND user2 = ?`, [g, m.user1, m.user2], conn);
        return { partnerId: m.partnerId };
    });
}

/** Marriage card data, or pending proposals when single. */
export async function marriageStatus(guildId, userId, { now = new Date(), rng = Math.random } = {}) {
    const g = String(guildId); const u = String(userId);
    const m = await marriageOf(null, g, u);
    if (m) {
        const days = Math.max(0, Math.floor((now.getTime() - new Date(m.marriedAt).getTime()) / DAY_MS));
        return { married: true, partnerId: m.partnerId, ring: ringById(m.ringId), marriedAt: m.marriedAt, daysMarried: days, dailies: m.dailies, compliment: pick(COMPLIMENTS, rng) };
    }
    const p = await proposalsOf(null, g, u);
    return { married: false, incoming: p.incoming && { ...p.incoming, ring: ringById(p.incoming.ringId) }, outgoing: p.outgoing && { ...p.outgoing, ring: ringById(p.outgoing.ringId) } };
}

/**
 * Daily couple bonus: once per couple per local day, never on the wedding day, and only when both partners have
 * claimed their game daily since the last local midnight. Both get the same acorns and the same item (50/50
 * lootbox or crate). Returns null when nothing was paid.
 */
export async function settleCoupleBonus(guildId, userId, { now = new Date(), rng = Math.random } = {}) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        const m = await marriageOf(conn, g, u, { lock: true });
        if (!m) return null;
        if (!isBeforeToday(m.marriedAt, now)) return null; // wedding day
        if (!isBeforeToday(m.bonusAt, now)) return null; // already paid today
        const ws = await q(`SELECT user_id, daily_at, daily_streak FROM ${T('wallet')} WHERE guild_id = ? AND user_id IN (?, ?)`, [g, m.user1, m.user2], conn);
        if (ws.length < 2) return null;
        const midnight = lastLocalMidnight(now).getTime();
        if (!ws.every(w => w.daily_at && new Date(w.daily_at).getTime() >= midnight)) return null;
        const amount = coupleBonusAmount(ws[0].daily_streak, ws[1].daily_streak, rng);
        const item = rng() < 0.5 ? 'lootbox' : 'crate';
        for (const id of [m.user1, m.user2]) {
            await credit(conn, g, id, amount);
            await addBoxes(conn, g, id, item, 1);
        }
        await q(`UPDATE ${T('marriages')} SET dailies = dailies + 1, bonus_at = ? WHERE guild_id = ? AND user1 = ? AND user2 = ?`, [now, g, m.user1, m.user2], conn);
        return { amount, item, partnerId: m.partnerId, dailies: m.dailies + 1 };
    });
}
