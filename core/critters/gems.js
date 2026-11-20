/*
 * Gems and lootboxes.
 */
import { q, T, withTx, CritterError } from './db.js';
import { LOOTBOX_OPEN_MAX } from './constants.js';
import { GEMS, GEM_TYPES, gemById, LOOTBOX_DROP } from './data/gems.js';
import { parseGemIds, rollLootboxGem, decideDailyDrop, GemInputError } from './rules/game-rules.js';
import { msUntilNextMidnight } from './rules/time.js';
import { readBoxes, takeBoxes, addBoxes, ensureBoxes } from './store.js';

/** Active gems ({ gemId, usesLeft } with usesLeft > 0). */
export async function readActiveGems(conn, g, u, { lock = false } = {}) {
    const rows = await q(`SELECT gem_id, uses_left FROM ${T('gems')} WHERE guild_id = ? AND user_id = ? AND uses_left > 0${lock ? ' FOR UPDATE' : ''}`, [g, u], conn);
    return rows.map(r => ({ gemId: Number(r.gem_id), usesLeft: Number(r.uses_left) }));
}

export async function writeGemBurns(conn, g, u, burns) {
    for (const b of burns) {
        await q(`UPDATE ${T('gems')} SET uses_left = ? WHERE guild_id = ? AND user_id = ? AND gem_id = ?`, [b.after, g, u, b.gemId], conn);
    }
}

/** { active: [{ gem, usesLeft, length }], inventory: [{ gem, count }] } */
export async function getGems(guildId, userId) {
    const rows = await q(`SELECT gem_id, owned, uses_left FROM ${T('gems')} WHERE guild_id = ? AND user_id = ?`, [String(guildId), String(userId)]);
    const active = [];
    const inventory = [];
    for (const r of rows) {
        const gem = gemById(r.gem_id);
        if (!gem) continue;
        if (Number(r.uses_left) > 0) active.push({ gem, usesLeft: Number(r.uses_left), length: gem.length });
        if (Number(r.owned) > 0) inventory.push({ gem, count: Number(r.owned) });
    }
    const order = (x) => GEM_TYPES.findIndex(t => t.key === x.gem.type) * 10 + x.gem.tier;
    return { active: active.sort((a, b) => order(a) - order(b)), inventory: inventory.sort((a, b) => order(a) - order(b)) };
}

/**
 * Switch gems on. 1..4 ids, at most one per type. Each activation takes one from the inventory and sets the
 * uses to the gem's length; any other running gem of the same type stops (one active per type).
 * Errors: NO_IDS, TOO_MANY, UNKNOWN_GEM, DUPLICATE_TYPE, NONE_OWNED (data.gemId).
 */
export async function useGems(guildId, userId, input) {
    const g = String(guildId); const u = String(userId);
    let ids;
    try {
        ids = parseGemIds(input);
    } catch (err) {
        if (err instanceof GemInputError) throw new CritterError(err.code, err.message, err.data);
        throw err;
    }
    return withTx(async (conn) => {
        const activated = [];
        for (const id of ids) {
            const gem = gemById(id);
            const r = await q(`UPDATE ${T('gems')} SET owned = owned - 1, uses_left = ? WHERE guild_id = ? AND user_id = ? AND gem_id = ? AND owned > 0`, [gem.length, g, u, id], conn);
            if (r.affectedRows !== 1) throw new CritterError('NONE_OWNED', `You do not have a ${gem.name} (${gem.id}).`, { gemId: id });
            const sameType = GEMS.filter(x => x.type === gem.type && x.id !== gem.id).map(x => x.id);
            await q(`UPDATE ${T('gems')} SET uses_left = 0 WHERE guild_id = ? AND user_id = ? AND gem_id IN (?)`, [g, u, sameType], conn);
            activated.push({ gem, usesLeft: gem.length });
        }
        return { activated };
    });
}

/** Admin / quest / prize grant of gems. */
export async function addGems(conn, g, u, gemId, n) {
    await q(`INSERT INTO ${T('gems')} (guild_id, user_id, gem_id, owned, uses_left) VALUES (?, ?, ?, ?, 0) ON DUPLICATE KEY UPDATE owned = owned + VALUES(owned)`, [g, u, gemId, n], conn);
}

/**
 * Open lootboxes: count is a number (1..100) or 'all' (everything up to 100). One guarded decrement.
 * Errors: NO_LOOTBOX, NOT_ENOUGH_LOOTBOXES (data.have), BAD_COUNT.
 * @returns {{ opened, left, gems: [{ gem, count }] }}
 */
export async function openLootboxes(guildId, userId, count = 1, { rng = Math.random } = {}) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        const boxes = await readBoxes(conn, g, u, { lock: true });
        let n;
        if (String(count).toLowerCase() === 'all') n = Math.min(boxes.lootboxes, LOOTBOX_OPEN_MAX);
        else {
            n = Math.floor(Number(count ?? 1));
            if (!Number.isSafeInteger(n) || n < 1 || n > LOOTBOX_OPEN_MAX) throw new CritterError('BAD_COUNT', `Open between 1 and ${LOOTBOX_OPEN_MAX} lootboxes at a time.`);
        }
        if (boxes.lootboxes <= 0) throw new CritterError('NO_LOOTBOX', 'You have no lootboxes. Hunting drops them.');
        const left = await takeBoxes(conn, g, u, 'lootbox', n);
        if (left == null) throw new CritterError('NOT_ENOUGH_LOOTBOXES', `You only have ${boxes.lootboxes}.`, { have: boxes.lootboxes });
        const tally = new Map();
        for (let i = 0; i < n; i++) {
            const gem = rollLootboxGem(rng);
            tally.set(gem.id, (tally.get(gem.id) || 0) + 1);
        }
        for (const [gemId, c] of tally) await addGems(conn, g, u, gemId, c);
        return { opened: n, left, gems: [...tally.entries()].map(([id, c]) => ({ gem: gemById(id), count: c })).sort((a, b) => a.gem.id - b.gem.id) };
    });
}

export async function grantLootboxes(guildId, userId, n) {
    const c = Math.floor(Number(n));
    if (!Number.isSafeInteger(c) || c === 0) throw new CritterError('BAD_AMOUNT', 'The count must be a non-zero whole number.');
    const total = await withTx(conn => addBoxes(conn, String(guildId), String(userId), 'lootbox', c));
    return { delta: c, total };
}

/**
 * Roll the daily lootbox drop for a manual hunt. Returns { dropped, count (drops today), max, resetsInMs, lootboxes }.
 */
export async function rollLootboxDrop(guildId, userId, { rng = Math.random, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        await ensureBoxes(conn, g, u);
        const b = await readBoxes(conn, g, u, { lock: true });
        const d = decideDailyDrop({ claims: b.lootboxDrops, windowAt: b.lootboxWindow, now, chance: LOOTBOX_DROP.chance, max: LOOTBOX_DROP.maxPerDay, rng });
        if (d.drop) {
            await q(`UPDATE ${T('boxes')} SET lootboxes = lootboxes + 1, lootbox_drops = ?, lootbox_window = ? WHERE guild_id = ? AND user_id = ?`, [d.claimsAfter, d.windowAfter, g, u], conn);
        } else if (d.stale) {
            await q(`UPDATE ${T('boxes')} SET lootbox_drops = 0, lootbox_window = ? WHERE guild_id = ? AND user_id = ?`, [d.windowAfter, g, u], conn);
        }
        return { dropped: d.drop, count: d.claimsAfter, max: d.max, resetsInMs: msUntilNextMidnight(now), lootboxes: b.lootboxes + (d.drop ? 1 : 0) };
    });
}
