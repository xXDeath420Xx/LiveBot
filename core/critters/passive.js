/*
 * Passive play: autohunt, ranch income and the daily luck roll.
 */
import { q, T, withTx, CritterError } from './db.js';
import { AUTOHUNT_INTERVAL_MS, AUTOHUNT_MAX_QUEUED, LUCK_COOLDOWN_MS, RANCH_MAX_HOURS } from './constants.js';
import { tierByKey } from './data/tiers.js';
import { autohuntQueue, rollCatches, groupCatches, ranchRate, ranchHours, rollLuckPrize } from './rules/game-rules.js';
import { credit, addBoxes, claimCooldown, readCooldown, setCooldown } from './store.js';
import { addCatches } from './zoo.js';
import { bumpQuest } from './quests.js';
import { loadBattleTeam } from './teams.js';
import logger from '../../utils/logger.js';

/* ----------------------------------------------------------------------------------------------- autohunt */

/** Switch autohunt on (or restart its clock): anchor = now, cycle counter 0. */
export async function enableAutohunt(guildId, userId, { now = new Date() } = {}) {
    await q(`INSERT INTO ${T('autohunt')} (guild_id, user_id, anchor_at, cycle_hunts, lifetime) VALUES (?, ?, ?, 0, 0)
             ON DUPLICATE KEY UPDATE anchor_at = VALUES(anchor_at), cycle_hunts = 0`, [String(guildId), String(userId), now]);
    return { enabled: true, anchorAt: now, intervalMs: AUTOHUNT_INTERVAL_MS, cap: AUTOHUNT_MAX_QUEUED };
}

export async function disableAutohunt(guildId, userId) {
    const r = await q(`DELETE FROM ${T('autohunt')} WHERE guild_id = ? AND user_id = ?`, [String(guildId), String(userId)]);
    return { disabled: r.affectedRows > 0 };
}

/** { enabled, queued, cap, nextInMs, lifetime, intervalMs } */
export async function autohuntStatus(guildId, userId, { now = new Date() } = {}) {
    const [r] = await q(`SELECT * FROM ${T('autohunt')} WHERE guild_id = ? AND user_id = ?`, [String(guildId), String(userId)]);
    if (!r) return { enabled: false, queued: 0, cap: AUTOHUNT_MAX_QUEUED, nextInMs: null, lifetime: 0, intervalMs: AUTOHUNT_INTERVAL_MS };
    const qd = autohuntQueue(r.anchor_at, now);
    return { enabled: true, queued: qd.queued, cap: AUTOHUNT_MAX_QUEUED, nextInMs: qd.nextInMs, lifetime: Number(r.lifetime), intervalMs: AUTOHUNT_INTERVAL_MS };
}

/**
 * Claim queued autohunts: single-critter hunts with no gems, multiplier, team XP or lootbox. Raw tier points are
 * paid. The anchor advances by exactly queued x 30 min. Errors: NOT_ENABLED, NOTHING_QUEUED (data.nextInMs).
 */
export async function claimAutohunt(guildId, userId, { rng = Math.random, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    const res = await withTx(async (conn) => {
        const [r] = await q(`SELECT * FROM ${T('autohunt')} WHERE guild_id = ? AND user_id = ? FOR UPDATE`, [g, u], conn);
        if (!r) throw new CritterError('NOT_ENABLED', 'Autohunt is off. Switch it on first.');
        const qd = autohuntQueue(r.anchor_at, now);
        if (qd.queued === 0) throw new CritterError('NOTHING_QUEUED', `Nothing yet: the next autohunt is ready in ${Math.ceil(qd.nextInMs / 60000)} min.`, { nextInMs: qd.nextInMs });
        const caught = rollCatches(qd.queued, 0, rng);
        const grouped = groupCatches(caught);
        await addCatches(conn, g, u, grouped);
        const currency = caught.reduce((s, sp) => s + tierByKey(sp.tier).points, 0);
        const balance = await credit(conn, g, u, currency);
        await q(`UPDATE ${T('autohunt')} SET anchor_at = ?, cycle_hunts = cycle_hunts + ?, lifetime = lifetime + ? WHERE guild_id = ? AND user_id = ?`,
            [qd.newAnchor, qd.queued, qd.queued, g, u], conn);
        return { queued: qd.queued, catches: grouped, currency, balance, lifetime: Number(r.lifetime) + qd.queued };
    });
    try { await bumpQuest(g, u, 'hunt', res.queued); } catch (e) { logger.warn('[critters] quest bump failed', { error: e.message }); }
    return res;
}

/* ----------------------------------------------------------------------------------------------- ranch */

async function teamTiers(g, u) {
    const t = await loadBattleTeam(g, u);
    return t ? t.team.slots.map(s => s.species.tier) : [];
}

/**
 * Ranch status. A member with no ranch history starts the clock here (no free 24 h on the first claim).
 * Returns { teamSize, ratePerHour, hours, cap, pending, nextInMs }.
 */
export async function ranchStatus(guildId, userId, { now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    let last = await readCooldown(null, g, u, 'ranch');
    if (!last) { await setCooldown(null, g, u, 'ranch', now); last = now; }
    const tiers = await teamTiers(g, u);
    const rate = ranchRate(tiers);
    const h = ranchHours(last, now);
    return { teamSize: tiers.length, ratePerHour: rate, hours: h.hours, cap: RANCH_MAX_HOURS, pending: h.hours * rate, nextInMs: h.nextInMs };
}

/**
 * Collect ranch income: hours (max 24) x the team's hourly rate. The first ever claim starts the clock and pays 0.
 * A zero rate stamps the claim and pays nothing. Errors: NOTHING_YET (data.nextInMs).
 */
export async function claimRanch(guildId, userId, { now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    const tiers = await teamTiers(g, u);
    const rate = ranchRate(tiers);
    return withTx(async (conn) => {
        const last = await readCooldown(conn, g, u, 'ranch');
        if (!last) {
            await setCooldown(conn, g, u, 'ranch', now);
            return { started: true, hours: 0, ratePerHour: rate, paid: 0, balance: null };
        }
        const [row] = await q(`SELECT used_at FROM ${T('cooldowns')} WHERE guild_id = ? AND user_id = ? AND action = 'ranch' FOR UPDATE`, [g, u], conn);
        const h = ranchHours(row.used_at, now);
        if (h.hours === 0) throw new CritterError('NOTHING_YET', `The ranch pays every hour; next payout in ${Math.ceil(h.nextInMs / 60000)} min.`, { nextInMs: h.nextInMs });
        await setCooldown(conn, g, u, 'ranch', now);
        if (rate === 0) return { started: false, hours: h.hours, ratePerHour: 0, paid: 0, balance: null };
        const paid = h.hours * rate;
        const balance = await credit(conn, g, u, paid);
        return { started: false, hours: h.hours, ratePerHour: rate, paid, balance };
    });
}

/* ----------------------------------------------------------------------------------------------- luck roll */

/**
 * The daily luck roll (24 h rolling). Errors: COOLDOWN (data.readyAt). Returns { prize, rolls, luckPoints, balance?, crates? }.
 */
export async function rollLuck(guildId, userId, { rng = Math.random, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        const cd = await claimCooldown(conn, g, u, 'luck', LUCK_COOLDOWN_MS, now);
        if (!cd.ok) throw new CritterError('COOLDOWN', 'You already rolled today.', cd);
        const prize = rollLuckPrize(rng);
        const out = { prize };
        if (prize.kind === 'currency') out.balance = await credit(conn, g, u, prize.amount);
        else out.crates = await addBoxes(conn, g, u, 'crate', prize.amount);
        await q(`INSERT INTO ${T('luck')} (guild_id, user_id, points, rolls) VALUES (?, ?, 0, 1) ON DUPLICATE KEY UPDATE rolls = rolls + 1`, [g, u], conn);
        const [l] = await q(`SELECT points, rolls FROM ${T('luck')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
        out.rolls = Number(l.rolls);
        out.luckPoints = Number(l.points);
        return out;
    });
}
