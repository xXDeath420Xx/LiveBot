/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Weapon generation + persistence layer. Owns the per-user weapon inventory
 * (owo_user_weapon, owo_user_weapon_passive) and the crate inventory
 * (owo_crate). Independent of Discord.js — commands build on top.
 */

import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { WEAPON_CLASSES, getWeaponById } from './battle/weapons/index.js';
import { PASSIVE_CLASSES } from './battle/passives/index.js';

// Rank roll weights matching upstream WeaponInterface.js.
const RANK_WEIGHTS = [
    { rank: 'Common',    weight: 0.2  },
    { rank: 'Uncommon',  weight: 0.2  },
    { rank: 'Rare',      weight: 0.2  },
    { rank: 'Epic',      weight: 0.2  },
    { rank: 'Mythical',  weight: 0.14 },
    { rank: 'Legendary', weight: 0.05 },
    { rank: 'Fabled',    weight: 0.01 },
];

const WEAR_ROLL = [
    { wear: 'Pristine', chance: 0.01, id: 4 },
    { wear: 'Fine',     chance: 0.05, id: 3 },
    { wear: 'Decent',   chance: 0.10, id: 2 },
    { wear: 'Worn',     chance: 0.84, id: 1 }, // remainder
];

// Shard prices for selling weapons (upstream mirror).
export const SHARD_PRICES = {
    Common: 1, Uncommon: 3, Rare: 5, Epic: 25,
    Mythical: 300, Legendary: 1000, Fabled: 5000,
};

function weightedPick(entries) {
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    for (const e of entries) {
        r -= e.weight;
        if (r <= 0) return e;
    }
    return entries[entries.length - 1];
}

function pickWear() {
    const r = Math.random();
    let cum = 0;
    for (const w of WEAR_ROLL) {
        cum += w.chance;
        if (r <= cum) return w;
    }
    return WEAR_ROLL[WEAR_ROLL.length - 1];
}

function pickWeaponClass() {
    const keys = Object.keys(WEAPON_CLASSES);
    return WEAPON_CLASSES[keys[Math.floor(Math.random() * keys.length)]];
}

/**
 * Build a fresh random weapon descriptor. No DB writes.
 * Returns { classKey, weaponId, rank, wear, wearId, stat, passives: [{name,id,quality}], emoji }
 */
export function generateWeapon(weaponId = null) {
    // A specific id is used when restoring an inventory we already know the shape of — the TYPE is
    // known, the rolled qualities are not, so those are still random.
    const WeaponCls = weaponId != null
        ? (getWeaponById(weaponId) ?? pickWeaponClass())
        : pickWeaponClass();
    const inst = new WeaponCls(null, null, true); // noCreate = don't roll internally

    const rankEntry = weightedPick(RANK_WEIGHTS);
    const wear = pickWear();

    // Random stat value from the weapon's qualityList[0] range
    const [qMin, qMax] = inst.qualityList?.[0] || [10, 20];
    const stat = Math.floor(qMin + Math.random() * (qMax - qMin + 1));

    // Pick 1 random passive from availablePassives (or all if 'all')
    const availablePassiveNames = inst.availablePassives === 'all'
        ? Object.keys(PASSIVE_CLASSES)
        : (Array.isArray(inst.availablePassives) ? inst.availablePassives : []);

    const passives = [];
    const passiveCount = inst.passiveCount ?? 1;
    const pool2 = [...availablePassiveNames];
    for (let i = 0; i < passiveCount && pool2.length > 0; i++) {
        const idx = Math.floor(Math.random() * pool2.length);
        const pname = pool2.splice(idx, 1)[0];
        const PCls = PASSIVE_CLASSES[pname];
        if (!PCls) continue;
        const pInst = new PCls(null, true);
        const [pqMin, pqMax] = pInst.qualityList?.[0] || [1, 5];
        const pq = Math.floor(pqMin + Math.random() * (pqMax - pqMin + 1));
        passives.push({ name: pname, id: pInst.id, quality: pq });
    }

    return {
        classKey: WeaponCls.name,
        weaponId: inst.id,
        name: inst.name,
        rank: rankEntry.rank,
        wear: wear.wear,
        wearId: wear.id,
        stat,
        passives,
        basicDesc: inst.basicDesc,
        emoji: inst.defaultEmoji || '🗡️',
        manaCost: inst.manaRange?.[0] || 100,
    };
}

/**
 * Persist a generated weapon to the DB for a specific (guild, user).
 * Returns { uwid, weapon }.
 */
export async function saveWeapon(guildId, userId, weapon) {
    // Encode the stat + passives into the `stat` string matching upstream's
    // format: '{rank} {value} {wear_id}'. Readable + future-compatible.
    const statStr = `${weapon.rank} ${weapon.stat} ${weapon.wearId}`;

    const [result] = await pool.execute(
        `INSERT INTO owo_user_weapon (guild_id, uid, wid, stat, wear, favorite, rrcount)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
        [guildId, userId, weapon.weaponId, statStr, weapon.wearId]
    );
    const uwid = result.insertId;

    // Save passives
    for (const p of weapon.passives) {
        await pool.execute(
            `INSERT INTO owo_user_weapon_passive (guild_id, uwid, wpid, pcount, stat)
             VALUES (?, ?, ?, ?, ?)`,
            [guildId, uwid, p.id, 1, String(p.quality)]
        );
    }

    return { uwid, ...weapon };
}

/**
 * List all weapons owned by a user.
 */
export async function listWeapons(guildId, userId, { limit = 50, offset = 0 } = {}) {
    const [rows] = await pool.execute(
        `SELECT uwid, wid, stat, wear, avg, rrcount, favorite, found
         FROM owo_user_weapon
         WHERE guild_id = ? AND uid = ?
         ORDER BY uwid DESC
         LIMIT ? OFFSET ?`,
        [guildId, userId, limit, offset]
    );

    return rows.map(r => {
        const WeaponCls = getWeaponById(r.wid);
        const inst = WeaponCls ? new WeaponCls(null, null, true) : null;
        const [rank, value, wearId] = String(r.stat || '').split(' ');
        return {
            uwid: Number(r.uwid),
            weaponId: r.wid,
            name: inst?.name || `weapon#${r.wid}`,
            emoji: inst?.defaultEmoji || '🗡️',
            rank,
            stat: Number(value) || 0,
            wearId: Number(wearId) || Number(r.wear) || 1,
            favorite: r.favorite === 1,
            found: r.found,
        };
    });
}

/**
 * Describe a specific weapon owned by the user.
 */
export async function describeWeapon(guildId, userId, uwid) {
    const [rows] = await pool.execute(
        `SELECT uwid, wid, stat, wear, favorite, found
         FROM owo_user_weapon
         WHERE guild_id = ? AND uid = ? AND uwid = ?`,
        [guildId, userId, uwid]
    );
    if (!rows.length) return null;
    const row = rows[0];

    const [passives] = await pool.execute(
        `SELECT wpid, stat FROM owo_user_weapon_passive WHERE guild_id = ? AND uwid = ?`,
        [guildId, uwid]
    );

    const WeaponCls = getWeaponById(row.wid);
    const inst = WeaponCls ? new WeaponCls(null, null, true) : null;
    const [rank, value, wearId] = String(row.stat || '').split(' ');

    const passiveDetails = passives.map(p => {
        // Find passive class by id
        for (const [name, PCls] of Object.entries(PASSIVE_CLASSES)) {
            try {
                const pi = new PCls(null, true);
                if (pi.id === p.wpid) {
                    return { name, id: p.wpid, quality: Number(p.stat) || 0, description: pi.basicDesc };
                }
            } catch { /* ignore */ }
        }
        return { name: `passive#${p.wpid}`, id: p.wpid, quality: Number(p.stat) || 0 };
    });

    return {
        uwid: Number(row.uwid),
        weaponId: row.wid,
        name: inst?.name,
        basicDesc: inst?.basicDesc,
        emoji: inst?.defaultEmoji || '🗡️',
        rank,
        stat: Number(value) || 0,
        wearId: Number(wearId) || 1,
        favorite: row.favorite === 1,
        found: row.found,
        passives: passiveDetails,
    };
}

// ── Crates ────────────────────────────────────────────────────────────

/**
 * Give a user a crate of given type (0 = basic weapon crate).
 */
export async function grantCrate(guildId, userId, cratetype = 0, count = 1) {
    await pool.execute(
        `INSERT INTO owo_crate (guild_id, uid, cratetype, boxcount, claimcount, claim)
         VALUES (?, ?, ?, ?, 0, NOW())
         ON DUPLICATE KEY UPDATE boxcount = boxcount + VALUES(boxcount)`,
        [guildId, userId, cratetype, count]
    );
}

export async function getCrateCount(guildId, userId, cratetype = 0) {
    const [rows] = await pool.execute(
        `SELECT boxcount FROM owo_crate WHERE guild_id = ? AND uid = ? AND cratetype = ?`,
        [guildId, userId, cratetype]
    );
    return Number(rows[0]?.boxcount) || 0;
}

/**
 * Open one crate → generate + save a weapon. Decrements crate count.
 * Throws if no crates available.
 */
export async function openCrate(guildId, userId, cratetype = 0) {
    const have = await getCrateCount(guildId, userId, cratetype);
    if (have < 1) throw new Error('No crates to open.');

    await pool.execute(
        `UPDATE owo_crate SET boxcount = boxcount - 1
         WHERE guild_id = ? AND uid = ? AND cratetype = ? AND boxcount > 0`,
        [guildId, userId, cratetype]
    );

    const weapon = generateWeapon();
    const saved = await saveWeapon(guildId, userId, weapon);
    return { weapon: saved, cratesLeft: have - 1 };
}

/**
 * Quick utility: give a user N crates (admin grant).
 */
export async function adminGrantCrate(guildId, userId, count = 1) {
    return grantCrate(guildId, userId, 0, count);
}

// ── Shards + dismantle + forge ─────────────────────────────────────

/** Shards awarded per weapon-rank when dismantled (upstream prices). */
const DISMANTLE_SHARDS = {
    Common: 1, Uncommon: 3, Rare: 5, Epic: 25,
    Mythical: 300, Legendary: 1000, Fabled: 5000,
};

/** Shards required to forge a weapon at this rank (upstream cost table). */
export const FORGE_COSTS = {
    Common: 5, Uncommon: 15, Rare: 40, Epic: 200,
    Mythical: 2000, Legendary: 7500, Fabled: 30000,
};

export async function getShards(guildId, userId) {
    const [[row]] = await pool.execute(
        'SELECT count FROM owo_shards WHERE guild_id = ? AND uid = ?',
        [guildId, userId]
    );
    return Number(row?.count) || 0;
}

async function addShards(guildId, userId, amount) {
    if (!amount) return;
    await pool.execute(
        `INSERT INTO owo_shards (guild_id, uid, count) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE count = count + VALUES(count)`,
        [guildId, userId, amount]
    );
}

async function spendShards(guildId, userId, amount) {
    const have = await getShards(guildId, userId);
    if (have < amount) return { ok: false, have, need: amount };
    await pool.execute(
        'UPDATE owo_shards SET count = count - ? WHERE guild_id = ? AND uid = ?',
        [amount, guildId, userId]
    );
    return { ok: true, remaining: have - amount };
}

/**
 * Dismantle a weapon by uwid — the weapon is deleted and the user gains
 * shards based on its rank. Refuses to dismantle favorites.
 */
export async function dismantleWeapon(guildId, userId, uwid) {
    const [[row]] = await pool.execute(
        'SELECT uwid, stat, wear, favorite FROM owo_user_weapon WHERE guild_id = ? AND uid = ? AND uwid = ?',
        [guildId, userId, uwid]
    );
    if (!row) return { error: `Weapon #${uwid} not found.` };
    if (row.favorite === 1) return { error: 'Cannot dismantle a favorited weapon. Un-favorite it first.' };
    const [rank] = String(row.stat || '').split(' ');
    const shards = DISMANTLE_SHARDS[rank] || 1;

    await pool.execute(
        'DELETE FROM owo_user_weapon_passive WHERE guild_id = ? AND uwid = ?',
        [guildId, uwid]
    );
    await pool.execute(
        'DELETE FROM owo_user_weapon WHERE guild_id = ? AND uid = ? AND uwid = ?',
        [guildId, userId, uwid]
    );
    await addShards(guildId, userId, shards);
    return { uwid: Number(uwid), rank, shards };
}

/**
 * Forge a weapon at the requested rank — costs shards, returns a newly
 * generated weapon pinned to that rank.
 */
export async function forgeWeapon(guildId, userId, targetRank) {
    const cost = FORGE_COSTS[targetRank];
    if (!cost) return { error: `Unknown rank: ${targetRank}` };
    const spend = await spendShards(guildId, userId, cost);
    if (!spend.ok) {
        return { error: `Need **${cost}** shards — you have ${spend.have}.` };
    }

    // Generate a weapon pinned to the target rank
    const weapon = generateWeapon();
    weapon.rank = targetRank;
    const saved = await saveWeapon(guildId, userId, weapon);
    return { weapon: saved, shardsSpent: cost, shardsLeft: spend.remaining };
}

/**
 * Favorite / un-favorite a weapon so it's protected from dismantle.
 */
export async function setFavorite(guildId, userId, uwid, favorite) {
    const [r] = await pool.execute(
        'UPDATE owo_user_weapon SET favorite = ? WHERE guild_id = ? AND uid = ? AND uwid = ?',
        [favorite ? 1 : 0, guildId, userId, uwid]
    );
    if (r.affectedRows === 0) return { error: `Weapon #${uwid} not found.` };
    return { uwid: Number(uwid), favorite: !!favorite };
}
