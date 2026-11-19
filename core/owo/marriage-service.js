/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 * Port of upstream OwO Bot's rings and marriage (src/data/rings.json, social/util/ringUtil.js,
 * social/marry.js, acceptMarriage.js, declineMarriage.js, divorce.js and the marriage half of
 * economy/daily.js — Copyright (C) Christopher Thai), per server.
 *
 *   owo_user_ring  (guild_id, uid, rid) rings a member owns (rcount)
 *   owo_propose    (migration 314) pending proposals. The proposer's ring is taken when they
 *                  propose and handed back if the proposal is declined/withdrawn. One outgoing and
 *                  one incoming proposal per member (PK + unique key). Lives in the DB, so a
 *                  restart never loses a proposal or the ring riding on it.
 *   owo_marriage   (migration 314) one row per couple, user1 < user2 numerically; unique keys stop
 *                  anyone being in two marriages.
 *   owo_ring       upstream's FK-only list of ring ids; the catalog itself is RINGS in social-math.js
 *                  (upstream keeps it in rings.json too).
 *
 * Marriage bonus (upstream daily.js): once a day, when BOTH partners have claimed their OwO daily
 * since midnight, each gets 100–1000 cowoncy (by combined streak) and a lootbox or weapon crate.
 * Not on the day you married. Triggered from either partner's daily claim (core/owo/manager.js).
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { withTx, OwoUserError } from './tx.js';
import { debitTx, creditTx } from './cowoncy.js';
import { RINGS, ringSellPrice, marriageBonus, sortPair, lastMidnight, isNewDay } from './social-math.js';

export { RINGS };

function ringOrThrow(rid) {
    const ring = RINGS[Number(rid)];
    if (!ring) throw new OwoUserError("That's not a valid ring id! Rings are 1–7 — see `owo shop`.");
    return ring;
}

// ── Rings ────────────────────────────────────────────────────────────────────

export async function buyRing(guildId, userId, rid) {
    const ring = ringOrThrow(rid);
    return withTx(async (conn) => {
        await debitTx(conn, guildId, userId, ring.price, "You don't have enough cowoncy! >:c");
        await conn.execute(
            `INSERT INTO owo_user_ring (guild_id, uid, rid, rcount) VALUES (?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE rcount = rcount + 1`,
            [guildId, userId, ring.id]
        );
        return ring;
    }, { label: 'ring-buy' });
}

export async function sellRing(guildId, userId, rid) {
    const ring = ringOrThrow(rid);
    const price = ringSellPrice(ring.id);
    return withTx(async (conn) => {
        const [r] = await conn.execute(
            'UPDATE owo_user_ring SET rcount = rcount - 1 WHERE guild_id = ? AND uid = ? AND rid = ? AND rcount > 0',
            [guildId, userId, ring.id]
        );
        if (r.affectedRows !== 1) throw new OwoUserError("You don't have that ring! >:c");
        await creditTx(conn, guildId, userId, price);
        return { ring, price };
    }, { label: 'ring-sell' });
}

/** @returns {Promise<Array<{ring, count: number}>>} */
export async function listRings(guildId, userId) {
    const [rows] = await pool.execute(
        'SELECT rid, rcount FROM owo_user_ring WHERE guild_id = ? AND uid = ? AND rcount > 0 ORDER BY rid',
        [guildId, userId]
    );
    return rows.filter(r => RINGS[r.rid]).map(r => ({ ring: RINGS[r.rid], count: Number(r.rcount) }));
}

async function takeRingTx(conn, guildId, userId, rid) {
    const [r] = await conn.execute(
        'UPDATE owo_user_ring SET rcount = rcount - 1 WHERE guild_id = ? AND uid = ? AND rid = ? AND rcount > 0',
        [guildId, userId, rid]
    );
    if (r.affectedRows !== 1) {
        throw new OwoUserError(`You don't have a **${RINGS[rid].name}**! Buy one with \`owo buy ${rid}\`.`, 'no_ring');
    }
}

async function giveRingTx(conn, guildId, userId, rid) {
    await conn.execute(
        `INSERT INTO owo_user_ring (guild_id, uid, rid, rcount) VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE rcount = rcount + 1`,
        [guildId, userId, rid]
    );
}

// ── Marriage ─────────────────────────────────────────────────────────────────

async function marriageOfTx(conn, guildId, userId, lock = false) {
    const [[row]] = await conn.execute(
        `SELECT user1, user2, rid, married_at, dailies, claim_date FROM owo_marriage
         WHERE guild_id = ? AND (user1 = ? OR user2 = ?) LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
        [guildId, userId, userId]
    );
    return row || null;
}

function partnerOf(row, userId) {
    return String(row.user1) === String(userId) ? String(row.user2) : String(row.user1);
}

/** Marriage info for `owo marry` with no arguments / profiles. */
export async function getMarriage(guildId, userId) {
    const row = await marriageOfTx(pool, guildId, userId);
    if (!row) return null;
    const marriedAt = new Date(row.married_at);
    return {
        partnerId: partnerOf(row, userId),
        ring: RINGS[row.rid] || RINGS[1],
        marriedAt,
        days: Math.max(0, Math.floor((Date.now() - marriedAt.getTime()) / 86_400_000)),
        dailies: Number(row.dailies) || 0,
    };
}

/** Pending proposals that involve this member (incoming and outgoing). */
export async function getProposals(guildId, userId) {
    const [rows] = await pool.execute(
        'SELECT sender, receiver, rid, created_at FROM owo_propose WHERE guild_id = ? AND (sender = ? OR receiver = ?)',
        [guildId, userId, userId]
    );
    return {
        incoming: rows.filter(r => String(r.receiver) === String(userId)).map(r => ({ from: String(r.sender), ring: RINGS[r.rid] })),
        outgoing: rows.filter(r => String(r.sender) === String(userId)).map(r => ({ to: String(r.receiver), ring: RINGS[r.rid] })),
    };
}

/**
 * Propose to `targetId` with ring `rid`. If the two are already married to each other this is a
 * ring upgrade instead — the caller should confirm first and call upgradeRing().
 * @returns {Promise<{proposed: true, ring} | {upgrade: true, currentRing, newRing}>}
 */
export async function propose(guildId, userId, targetId, rid, channelId = null) {
    const ring = ringOrThrow(rid);
    if (String(userId) === String(targetId)) throw new OwoUserError("Silly. You can't marry yourself!");
    return withTx(async (conn) => {
        const mine = await marriageOfTx(conn, guildId, userId, true);
        if (mine) {
            if (partnerOf(mine, userId) === String(targetId)) {
                if (Number(mine.rid) === ring.id) throw new OwoUserError('You silly. You are already using a ring with the same rarity!');
                const [[owned]] = await conn.execute(
                    'SELECT rcount FROM owo_user_ring WHERE guild_id = ? AND uid = ? AND rid = ?', [guildId, userId, ring.id]);
                if (!(Number(owned?.rcount) > 0)) throw new OwoUserError("You cannot upgrade your ring if you don't have it, silly!");
                return { upgrade: true, currentRing: RINGS[mine.rid], newRing: ring };
            }
            throw new OwoUserError('You are already married!');
        }
        if (await marriageOfTx(conn, guildId, targetId, true)) throw new OwoUserError('They are already married!');

        const [pending] = await conn.execute(
            `SELECT sender FROM owo_propose WHERE guild_id = ? AND (sender IN (?, ?) OR receiver IN (?, ?)) FOR UPDATE`,
            [guildId, userId, targetId, userId, targetId]
        );
        if (pending.length) throw new OwoUserError('You or your friend already has a marriage proposal pending! (`owo dm` cancels it)');

        await takeRingTx(conn, guildId, userId, ring.id);
        await conn.execute(
            'INSERT INTO owo_propose (guild_id, sender, receiver, rid, channel_id) VALUES (?, ?, ?, ?, ?)',
            [guildId, userId, targetId, ring.id, channelId ? String(channelId) : null]
        );
        return { proposed: true, ring };
    }, { label: 'marry-propose' });
}

/** Swap the couple's ring for a better (or different) one. The old ring breaks, as upstream. */
export async function upgradeRing(guildId, userId, rid) {
    const ring = ringOrThrow(rid);
    return withTx(async (conn) => {
        const mine = await marriageOfTx(conn, guildId, userId, true);
        if (!mine) throw new OwoUserError('You are currently not married...');
        if (Number(mine.rid) === ring.id) throw new OwoUserError('You silly. You are already using a ring with the same rarity!');
        await takeRingTx(conn, guildId, userId, ring.id);
        await conn.execute(
            'UPDATE owo_marriage SET rid = ? WHERE guild_id = ? AND user1 = ? AND user2 = ?',
            [ring.id, guildId, mine.user1, mine.user2]
        );
        return { ring, partnerId: partnerOf(mine, userId) };
    }, { label: 'marry-upgrade' });
}

/** `owo am` — accept the proposal sent to you. */
export async function acceptProposal(guildId, userId) {
    return withTx(async (conn) => {
        const [[prop]] = await conn.execute(
            'SELECT sender, rid FROM owo_propose WHERE guild_id = ? AND receiver = ? FOR UPDATE', [guildId, userId]);
        if (!prop) throw new OwoUserError('You do not have any pending marriage proposals!');
        const senderId = String(prop.sender);
        await conn.execute('DELETE FROM owo_propose WHERE guild_id = ? AND sender = ?', [guildId, senderId]);

        // Either side may have married someone else since the proposal was made.
        if (await marriageOfTx(conn, guildId, senderId, true) || await marriageOfTx(conn, guildId, userId, true)) {
            await giveRingTx(conn, guildId, senderId, prop.rid);
            return { failed: 'already_married', senderId };
        }
        const [user1, user2] = sortPair(senderId, userId);
        await conn.execute(
            'INSERT INTO owo_marriage (guild_id, user1, user2, rid) VALUES (?, ?, ?, ?)',
            [guildId, user1, user2, prop.rid]
        );
        return { senderId, ring: RINGS[prop.rid] || RINGS[1] };
    }, { label: 'marry-accept' });
}

/** `owo dm` — decline a proposal to you, or withdraw your own. The ring goes back to the proposer. */
export async function declineProposal(guildId, userId) {
    return withTx(async (conn) => {
        const [rows] = await conn.execute(
            'SELECT sender, receiver, rid FROM owo_propose WHERE guild_id = ? AND (sender = ? OR receiver = ?) FOR UPDATE',
            [guildId, userId, userId]
        );
        if (!rows.length) throw new OwoUserError('You do not have any pending marriage proposals!');
        // Prefer the incoming one (that's what "decline" means); fall back to withdrawing your own.
        const prop = rows.find(r => String(r.receiver) === String(userId)) || rows[0];
        await conn.execute('DELETE FROM owo_propose WHERE guild_id = ? AND sender = ?', [guildId, prop.sender]);
        await giveRingTx(conn, guildId, String(prop.sender), prop.rid);
        const outgoing = String(prop.sender) === String(userId);
        return { otherId: outgoing ? String(prop.receiver) : String(prop.sender), outgoing, ring: RINGS[prop.rid] };
    }, { label: 'marry-decline' });
}

/** `owo divorce` — ends the marriage; the ring breaks. */
export async function divorce(guildId, userId) {
    return withTx(async (conn) => {
        const row = await marriageOfTx(conn, guildId, userId, true);
        if (!row) throw new OwoUserError("You can't divorce if you aren't married, silly butt!");
        await conn.execute('DELETE FROM owo_marriage WHERE guild_id = ? AND user1 = ? AND user2 = ?', [guildId, row.user1, row.user2]);
        return { partnerId: partnerOf(row, userId), dailies: Number(row.dailies) || 0 };
    }, { label: 'marry-divorce' });
}

/**
 * Pay the daily marriage bonus if it is due. Safe to call on every daily claim (and on a daily
 * that is still on cooldown — upstream's "double check"): it only pays once per couple per day.
 * @returns {Promise<null | {partnerId, amount, item: 'lootbox'|'crate', ring, dailies}>}
 */
export async function settleMarriageDaily(guildId, userId) {
    const quick = await marriageOfTx(pool, guildId, userId);
    if (!quick) return null;
    return withTx(async (conn) => {
        const row = await marriageOfTx(conn, guildId, userId, true);
        if (!row) return null;
        const midnight = lastMidnight();
        if (new Date(row.married_at) >= midnight) return null;     // not on the wedding day
        if (!isNewDay(row.claim_date)) return null;                // already paid today

        const [cows] = await conn.execute(
            'SELECT id, daily, daily_streak FROM owo_cowoncy WHERE guild_id = ? AND id IN (?, ?)',
            [guildId, row.user1, row.user2]
        );
        if (cows.length < 2) return null;
        if (cows.some(c => isNewDay(c.daily))) return null;       // one of them hasn't claimed today

        const amount = marriageBonus(cows.reduce((s, c) => s + (Number(c.daily_streak) || 0), 0));
        const item = Math.random() < 0.5 ? 'lootbox' : 'crate';
        for (const id of [row.user1, row.user2]) {
            await creditTx(conn, guildId, id, amount);
            if (item === 'lootbox') {
                // claim '2017-01-01' keeps a new row from eating today's free hunt lootbox (daily-drop.js).
                await conn.execute(
                    `INSERT INTO owo_lootbox (guild_id, id, boxcount, claimcount, claim) VALUES (?, ?, 1, 0, '2017-01-01')
                     ON DUPLICATE KEY UPDATE boxcount = boxcount + 1`,
                    [guildId, id]
                );
            } else {
                await conn.execute(
                    `INSERT INTO owo_crate (guild_id, uid, cratetype, boxcount, claimcount, claim) VALUES (?, ?, 0, 1, 0, '2017-01-01')
                     ON DUPLICATE KEY UPDATE boxcount = boxcount + 1`,
                    [guildId, id]
                );
            }
        }
        await conn.execute(
            'UPDATE owo_marriage SET claim_date = NOW(), dailies = dailies + 1 WHERE guild_id = ? AND user1 = ? AND user2 = ?',
            [guildId, row.user1, row.user2]
        );
        logger.debug?.('[OwO] marriage daily paid', { guildId, user1: row.user1, user2: row.user2, amount, item });
        return { partnerId: partnerOf(row, userId), amount, item, ring: RINGS[row.rid] || RINGS[1], dailies: (Number(row.dailies) || 0) + 1 };
    }, { label: 'marry-daily' });
}
