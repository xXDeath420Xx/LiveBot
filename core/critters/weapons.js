/*
 * Weapons: crates, the armory, details, dismantling into shards, forging, favourites, crate drops and grants.
 */
import { q, T, withTx, CritterError } from './db.js';
import { CRATE_GRANT_MAX } from './constants.js';
import { rankByKey, RANKS, CRATE_DROP } from './data/weapons.js';
import { generateWeapon, describeWeapon, dismantleShards, FORGE_PRICES } from './rules/weapon-rules.js';
import { decideDailyDrop } from './rules/game-rules.js';
import { msUntilNextMidnight } from './rules/time.js';
import { readBoxes, takeBoxes, addBoxes, ensureBoxes, readWallet, addWalletField, spendWalletField } from './store.js';

function rowToWeapon(r, perks = []) {
    return {
        uwid: Number(r.uwid), guildId: r.guild_id, userId: r.user_id, typeId: Number(r.type_id), rankId: Number(r.rank_id),
        quality: Number(r.quality), wear: Number(r.wear), favorite: !!r.favorite, petPid: r.pet_pid == null ? null : Number(r.pet_pid),
        kills: r.kills == null ? null : Number(r.kills), foundAt: r.found_at,
        perks: perks.map(p => ({ slot: Number(p.slot), perkId: Number(p.perk_id), quality: Number(p.quality) })),
    };
}

/** Load weapons with their perks. where: SQL fragment with params (fixed in this file). */
export async function loadWeapons(conn, where, params) {
    const rows = await q(`SELECT * FROM ${T('weapons')} WHERE ${where}`, params, conn);
    if (!rows.length) return [];
    const perks = await q(`SELECT * FROM ${T('weapon_perks')} WHERE uwid IN (?) ORDER BY uwid, slot`, [rows.map(r => r.uwid)], conn);
    const byUwid = new Map();
    for (const p of perks) {
        if (!byUwid.has(Number(p.uwid))) byUwid.set(Number(p.uwid), []);
        byUwid.get(Number(p.uwid)).push(p);
    }
    return rows.map(r => rowToWeapon(r, byUwid.get(Number(r.uwid)) || []));
}

/** Insert a generated weapon. Returns the stored weapon. */
export async function saveWeapon(conn, g, u, w) {
    const r = await q(`INSERT INTO ${T('weapons')} (guild_id, user_id, type_id, rank_id, quality, wear, favorite, kills, found_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NOW())`,
        [g, u, w.typeId, w.rankId, w.quality, w.wear, w.tracked ? 0 : null], conn);
    const uwid = Number(r.insertId);
    for (const p of w.perks) {
        await q(`INSERT INTO ${T('weapon_perks')} (uwid, slot, guild_id, user_id, perk_id, quality) VALUES (?, ?, ?, ?, ?, ?)`, [uwid, p.slot, g, u, p.perkId, p.quality], conn);
    }
    return { ...w, uwid, kills: w.tracked ? 0 : null, favorite: false, petPid: null };
}

/** Open one crate. Errors: NO_CRATE. Returns { weapon (described), cratesLeft }. */
export async function openCrate(guildId, userId, { rng = Math.random } = {}) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        const left = await takeBoxes(conn, g, u, 'crate', 1);
        if (left == null) throw new CritterError('NO_CRATE', 'You have no weapon crates. Battles drop them, and server admins can grant them.');
        const saved = await saveWeapon(conn, g, u, generateWeapon(rng));
        return { weapon: describeWeapon(saved), cratesLeft: left };
    });
}

/** Armory: newest weapons first (default 30). */
export async function listWeapons(guildId, userId, { limit = 30 } = {}) {
    const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)));
    const g = String(guildId); const u = String(userId);
    const ws = await loadWeapons(null, 'guild_id = ? AND user_id = ? ORDER BY uwid DESC LIMIT ?', [g, u, n]);
    const [c] = await q(`SELECT COUNT(*) AS n FROM ${T('weapons')} WHERE guild_id = ? AND user_id = ?`, [g, u]);
    return { total: Number(c.n), weapons: ws.map(describeWeapon) };
}

/** One weapon you own. Errors: NOT_FOUND. */
export async function getWeapon(guildId, userId, uwid) {
    const [w] = await loadWeapons(null, 'guild_id = ? AND user_id = ? AND uwid = ?', [String(guildId), String(userId), Number(uwid)]);
    if (!w) throw new CritterError('NOT_FOUND', `You do not own weapon ${uwid}.`);
    return describeWeapon(w);
}

/** Dismantle into shards. Errors: NOT_FOUND, FAVORITE. Returns { weapon, shards, shardsTotal }. */
export async function dismantleWeapon(guildId, userId, uwid) {
    const g = String(guildId); const u = String(userId); const id = Number(uwid);
    return withTx(async (conn) => {
        const [w] = await loadWeapons(conn, 'guild_id = ? AND user_id = ? AND uwid = ? FOR UPDATE', [g, u, id]);
        if (!w) throw new CritterError('NOT_FOUND', `You do not own weapon ${uwid}.`);
        if (w.favorite) throw new CritterError('FAVORITE', 'That weapon is a favourite. Unmark it first.');
        await q(`DELETE FROM ${T('weapon_perks')} WHERE uwid = ?`, [id], conn);
        await q(`DELETE FROM ${T('weapons')} WHERE uwid = ?`, [id], conn);
        const shards = dismantleShards(w.rankId);
        const shardsTotal = await addWalletField(conn, g, u, 'shards', shards);
        return { weapon: describeWeapon(w), shards, shardsTotal };
    });
}

/** Forge a random weapon of a rank. Errors: BAD_RANK, NOT_ENOUGH_SHARDS (data.cost, data.have). */
export async function forgeWeapon(guildId, userId, rankKey, { rng = Math.random } = {}) {
    const g = String(guildId); const u = String(userId);
    const rank = rankByKey(rankKey);
    if (!rank) throw new CritterError('BAD_RANK', `Pick a rank: ${RANKS.map(r => r.name).join(', ')}.`);
    return withTx(async (conn) => {
        if (!(await spendWalletField(conn, g, u, 'shards', rank.forge))) {
            const w = await readWallet(conn, g, u);
            throw new CritterError('NOT_ENOUGH_SHARDS', `Forging a ${rank.name} weapon takes ${rank.forge} shards; you have ${w.shards}.`, { cost: rank.forge, have: w.shards });
        }
        const saved = await saveWeapon(conn, g, u, generateWeapon(rng, { rankId: rank.id }));
        const w = await readWallet(conn, g, u);
        return { weapon: describeWeapon(saved), cost: rank.forge, shardsLeft: w.shards };
    });
}

export function forgePrices() {
    return FORGE_PRICES;
}

/** Mark or unmark a favourite (favourites cannot be dismantled). Errors: NOT_FOUND. */
export async function setFavorite(guildId, userId, uwid, favorite) {
    const r = await q(`UPDATE ${T('weapons')} SET favorite = ? WHERE guild_id = ? AND user_id = ? AND uwid = ?`, [favorite ? 1 : 0, String(guildId), String(userId), Number(uwid)]);
    if (r.affectedRows !== 1) {
        const [x] = await q(`SELECT uwid FROM ${T('weapons')} WHERE guild_id = ? AND user_id = ? AND uwid = ?`, [String(guildId), String(userId), Number(uwid)]);
        if (!x) throw new CritterError('NOT_FOUND', `You do not own weapon ${uwid}.`);
    }
    return { uwid: Number(uwid), favorite: !!favorite };
}

export async function getShards(guildId, userId) {
    return (await readWallet(null, String(guildId), String(userId))).shards;
}

/** Admin / dashboard shard grant (negative removes, floored at 0). Returns { delta, total }. */
export async function grantShards(guildId, userId, amount) {
    const d = Math.trunc(Number(amount));
    if (!Number.isSafeInteger(d) || d === 0) throw new CritterError('BAD_AMOUNT', 'The amount must be a non-zero whole number.');
    const total = await withTx(conn => addWalletField(conn, String(guildId), String(userId), 'shards', d));
    return { delta: d, total };
}

/** Admin crate grant (1..1000). New rows get epoch drop windows (no lost first daily crate). Returns { delta, total }. */
export async function grantCrates(guildId, userId, count = 1) {
    const c = Math.floor(Number(count));
    if (!Number.isSafeInteger(c) || c < 1 || c > CRATE_GRANT_MAX) throw new CritterError('BAD_AMOUNT', `Grant between 1 and ${CRATE_GRANT_MAX} crates.`);
    const total = await withTx(conn => addBoxes(conn, String(guildId), String(userId), 'crate', c));
    return { delta: c, total };
}

export async function getCrateCount(guildId, userId) {
    return (await readBoxes(null, String(guildId), String(userId))).crates;
}

/** Roll the daily crate drop for the challenger after a battle. Returns { dropped, count, max, resetsInMs, crates }. */
export async function rollCrateDrop(guildId, userId, { rng = Math.random, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        await ensureBoxes(conn, g, u);
        const b = await readBoxes(conn, g, u, { lock: true });
        const d = decideDailyDrop({ claims: b.crateDrops, windowAt: b.crateWindow, now, chance: CRATE_DROP.chance, max: CRATE_DROP.maxPerDay, rng });
        if (d.drop) {
            await q(`UPDATE ${T('boxes')} SET crates = crates + 1, crate_drops = ?, crate_window = ? WHERE guild_id = ? AND user_id = ?`, [d.claimsAfter, d.windowAfter, g, u], conn);
        } else if (d.stale) {
            await q(`UPDATE ${T('boxes')} SET crate_drops = 0, crate_window = ? WHERE guild_id = ? AND user_id = ?`, [d.windowAfter, g, u], conn);
        }
        return { dropped: d.drop, count: d.claimsAfter, max: d.max, resetsInMs: msUntilNextMidnight(now), crates: b.crates + (d.drop ? 1 : 0) };
    });
}

/** Add takedowns to tracked weapons (kills IS NOT NULL). kills: [{ uwid, kills }] with uwid > 0. */
export async function recordKills(kills) {
    for (const k of kills || []) {
        if (!(k.uwid > 0) || !(k.kills > 0)) continue;
        await q(`UPDATE ${T('weapons')} SET kills = kills + ? WHERE uwid = ? AND kills IS NOT NULL`, [k.kills, k.uwid]);
    }
}
