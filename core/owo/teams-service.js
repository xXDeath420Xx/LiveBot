/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Pet-team management: create teams, add/remove animals, equip weapons,
 * switch active team, read the active team with full stats (ready for the
 * battle engine). Per-guild isolation via guild_id on every row.
 *
 * Schema (from migration 089):
 *   owo_pet_team         (guild_id, uid, pgid, tname, win/lose, streak, ...)
 *   owo_pet_team_active  (guild_id, uid, pgid)
 *   owo_pet_team_animal  (guild_id, pgid, pos, pid)   — pid refs owo_animal.pid
 *   owo_user_weapon      (guild_id, uid, uwid, wid, stat, wear, pid, ...)
 *                        — when a weapon's pid matches an owo_animal.pid, it's
 *                          equipped on that animal.
 */

import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getAnimal } from './catalog.js';
import { getWeaponById } from './battle/weapons/index.js';
import { PASSIVE_CLASSES } from './battle/passives/index.js';

export const MAX_TEAM_SIZE = 3;
export const MAX_TEAMS_PER_USER = 5;
const WEAR_NAMES = { 4: 'Pristine', 3: 'Fine', 2: 'Decent', 1: 'Worn', 0: 'Unknown' };

// ── Team CRUD ──────────────────────────────────────────────────────

/**
 * Create a new team. Returns { pgid, tname }. Fails if user is at MAX_TEAMS.
 */
export async function createTeam(guildId, userId, tname = null) {
    const [[{ n }]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM owo_pet_team WHERE guild_id = ? AND uid = ?',
        [guildId, userId]
    );
    if (Number(n) >= MAX_TEAMS_PER_USER) {
        return { error: `Max ${MAX_TEAMS_PER_USER} teams per user.` };
    }

    // pgid is an auto_increment column (UNIQUE) per our schema. Let MySQL pick.
    const name = tname?.slice(0, 50) || `Team ${Number(n) + 1}`;
    const [result] = await pool.execute(
        `INSERT INTO owo_pet_team (guild_id, uid, tname, win, lose, censor, streak, highest_streak, disabled)
         VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)`,
        [guildId, userId, name]
    );
    const pgid = result.insertId;

    // If no active team yet, set this one as active.
    await pool.execute(
        `INSERT IGNORE INTO owo_pet_team_active (guild_id, uid, pgid) VALUES (?, ?, ?)`,
        [guildId, userId, pgid]
    );

    return { pgid, tname: name };
}

export async function renameTeam(guildId, userId, pgid, newName) {
    const name = String(newName || '').slice(0, 50).trim();
    if (!name) return { error: 'Empty name.' };
    const [r] = await pool.execute(
        'UPDATE owo_pet_team SET tname = ? WHERE guild_id = ? AND uid = ? AND pgid = ?',
        [name, guildId, userId, pgid]
    );
    if (r.affectedRows === 0) return { error: 'Team not found.' };
    return { pgid, tname: name };
}

export async function deleteTeam(guildId, userId, pgid) {
    const [[count]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM owo_pet_team WHERE guild_id = ? AND uid = ?',
        [guildId, userId]
    );
    if (Number(count.n) <= 1) return { error: 'Cannot delete your last team.' };

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('DELETE FROM owo_pet_team_animal WHERE guild_id = ? AND pgid = ?', [guildId, pgid]);
        await conn.execute('DELETE FROM owo_pet_team WHERE guild_id = ? AND uid = ? AND pgid = ?', [guildId, userId, pgid]);

        // If it was the active team, pick a remaining team as active.
        const [[active]] = await conn.execute(
            'SELECT pgid FROM owo_pet_team_active WHERE guild_id = ? AND uid = ?',
            [guildId, userId]
        );
        if (active?.pgid === pgid || active?.pgid === Number(pgid)) {
            const [[other]] = await conn.execute(
                'SELECT pgid FROM owo_pet_team WHERE guild_id = ? AND uid = ? LIMIT 1',
                [guildId, userId]
            );
            if (other?.pgid) {
                await conn.execute(
                    'UPDATE owo_pet_team_active SET pgid = ? WHERE guild_id = ? AND uid = ?',
                    [other.pgid, guildId, userId]
                );
            } else {
                await conn.execute(
                    'DELETE FROM owo_pet_team_active WHERE guild_id = ? AND uid = ?',
                    [guildId, userId]
                );
            }
        }
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
    return { pgid };
}

export async function listTeams(guildId, userId) {
    const [rows] = await pool.execute(
        `SELECT t.pgid, t.tname, t.win, t.lose, t.streak, t.highest_streak,
                a.pgid AS active_pgid
         FROM owo_pet_team t
         LEFT JOIN owo_pet_team_active a ON a.guild_id = t.guild_id AND a.uid = t.uid
         WHERE t.guild_id = ? AND t.uid = ?
         ORDER BY t.pgid ASC`,
        [guildId, userId]
    );
    return rows.map(r => ({
        pgid: Number(r.pgid),
        tname: r.tname,
        win: Number(r.win) || 0,
        lose: Number(r.lose) || 0,
        streak: Number(r.streak) || 0,
        highestStreak: Number(r.highest_streak) || 0,
        active: r.active_pgid != null && Number(r.active_pgid) === Number(r.pgid),
    }));
}

export async function setActiveTeam(guildId, userId, pgid) {
    // Verify ownership
    const [[row]] = await pool.execute(
        'SELECT pgid FROM owo_pet_team WHERE guild_id = ? AND uid = ? AND pgid = ?',
        [guildId, userId, pgid]
    );
    if (!row) return { error: 'Team not found.' };
    await pool.execute(
        `INSERT INTO owo_pet_team_active (guild_id, uid, pgid) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE pgid = VALUES(pgid)`,
        [guildId, userId, pgid]
    );
    return { pgid: Number(pgid) };
}

export async function getActivePgid(guildId, userId) {
    const [[r]] = await pool.execute(
        'SELECT pgid FROM owo_pet_team_active WHERE guild_id = ? AND uid = ?',
        [guildId, userId]
    );
    return r?.pgid != null ? Number(r.pgid) : null;
}

/**
 * Ensure the user has at least one team. Creates a default if not.
 */
export async function ensureDefaultTeam(guildId, userId) {
    let pgid = await getActivePgid(guildId, userId);
    if (pgid) return pgid;
    const created = await createTeam(guildId, userId, null);
    return created.pgid;
}

// ── Team roster ───────────────────────────────────────────────────

/**
 * Add an animal (by shortcode name) to a team at the lowest open position.
 * Position: 1..MAX_TEAM_SIZE. Fails if no slot open or animal not owned.
 */
export async function addAnimalToTeam(guildId, userId, pgid, animalName) {
    // Ownership + fetch pid of user's animal
    const [[own]] = await pool.execute(
        'SELECT pid, count FROM owo_animal WHERE guild_id = ? AND id = ? AND name = ?',
        [guildId, userId, animalName]
    );
    if (!own) return { error: `You don't own \`${animalName}\`.` };

    // Slot availability + duplicate-on-team check
    const [existing] = await pool.execute(
        'SELECT pos, pid FROM owo_pet_team_animal WHERE guild_id = ? AND pgid = ? ORDER BY pos',
        [guildId, pgid]
    );
    if (existing.some(e => e.pid === own.pid)) {
        return { error: `That animal is already on the team.` };
    }
    const takenPos = new Set(existing.map(e => e.pos));
    let slot = null;
    for (let p = 1; p <= MAX_TEAM_SIZE; p++) { if (!takenPos.has(p)) { slot = p; break; } }
    if (slot == null) return { error: `Team is full (${MAX_TEAM_SIZE} animals max).` };

    await pool.execute(
        `INSERT INTO owo_pet_team_animal (guild_id, pgid, pos, pid) VALUES (?, ?, ?, ?)`,
        [guildId, pgid, slot, own.pid]
    );

    // Mark the animal as ispet so upstream UI treats it as a pet
    await pool.execute(
        'UPDATE owo_animal SET ispet = 1 WHERE guild_id = ? AND id = ? AND pid = ?',
        [guildId, userId, own.pid]
    );

    return { pgid: Number(pgid), pos: slot, pid: Number(own.pid), animalName };
}

export async function removeAnimalFromTeam(guildId, userId, pgid, pos) {
    const [[slot]] = await pool.execute(
        'SELECT pid FROM owo_pet_team_animal WHERE guild_id = ? AND pgid = ? AND pos = ?',
        [guildId, pgid, pos]
    );
    if (!slot) return { error: `No animal at position ${pos}.` };

    await pool.execute(
        'DELETE FROM owo_pet_team_animal WHERE guild_id = ? AND pgid = ? AND pos = ?',
        [guildId, pgid, pos]
    );
    // Un-equip any weapon on that pid
    await pool.execute(
        'UPDATE owo_user_weapon SET pid = NULL WHERE guild_id = ? AND uid = ? AND pid = ?',
        [guildId, userId, slot.pid]
    );
    return { pgid: Number(pgid), pos };
}

// ── Weapon equip ──────────────────────────────────────────────────

/**
 * Equip a weapon onto the animal at team position `pos`.
 */
export async function equipWeapon(guildId, userId, pgid, pos, uwid) {
    const [[slot]] = await pool.execute(
        'SELECT pid FROM owo_pet_team_animal WHERE guild_id = ? AND pgid = ? AND pos = ?',
        [guildId, pgid, pos]
    );
    if (!slot) return { error: `No animal at position ${pos}.` };

    // Ensure the weapon belongs to the user
    const [[wep]] = await pool.execute(
        'SELECT uwid FROM owo_user_weapon WHERE guild_id = ? AND uid = ? AND uwid = ?',
        [guildId, userId, uwid]
    );
    if (!wep) return { error: `Weapon #${uwid} not found.` };

    // Un-equip this weapon from wherever it was, and any other weapon on the
    // target pid (one weapon per pet).
    await pool.execute(
        'UPDATE owo_user_weapon SET pid = NULL WHERE guild_id = ? AND uid = ? AND pid = ?',
        [guildId, userId, slot.pid]
    );
    await pool.execute(
        'UPDATE owo_user_weapon SET pid = ? WHERE guild_id = ? AND uid = ? AND uwid = ?',
        [slot.pid, guildId, userId, uwid]
    );
    return { pgid: Number(pgid), pos, uwid, pid: slot.pid };
}

export async function unequipWeapon(guildId, userId, pgid, pos) {
    const [[slot]] = await pool.execute(
        'SELECT pid FROM owo_pet_team_animal WHERE guild_id = ? AND pgid = ? AND pos = ?',
        [guildId, pgid, pos]
    );
    if (!slot) return { error: `No animal at position ${pos}.` };
    const [r] = await pool.execute(
        'UPDATE owo_user_weapon SET pid = NULL WHERE guild_id = ? AND uid = ? AND pid = ?',
        [guildId, userId, slot.pid]
    );
    return { pgid: Number(pgid), pos, cleared: r.affectedRows };
}

// ── Read active team with full details ───────────────────────────

/**
 * Snapshot the active team — team meta + animals w/ stats + equipped weapons
 * with passives. This is the shape the battle engine consumes.
 */
export async function getTeamDetails(guildId, userId, pgid = null) {
    const resolvedPgid = pgid ?? await getActivePgid(guildId, userId);
    if (!resolvedPgid) return null;

    const [[team]] = await pool.execute(
        'SELECT pgid, tname, win, lose, streak, highest_streak FROM owo_pet_team WHERE guild_id = ? AND uid = ? AND pgid = ?',
        [guildId, userId, resolvedPgid]
    );
    if (!team) return null;

    const [slots] = await pool.execute(
        `SELECT tpa.pos, a.pid, a.name, a.count, a.xp, a.nickname, a.ispet, an.rank, an.hp, an.att, an.pr, an.wp, an.mag, an.mr
         FROM owo_pet_team_animal tpa
         JOIN owo_animal a ON a.guild_id = tpa.guild_id AND a.pid = tpa.pid
         LEFT JOIN owo_animals an ON an.name = a.name
         WHERE tpa.guild_id = ? AND tpa.pgid = ?
         ORDER BY tpa.pos`,
        [guildId, resolvedPgid]
    );

    const animals = [];
    for (const s of slots) {
        // Find equipped weapon (if any) for this animal pid
        const [[wep]] = await pool.execute(
            `SELECT uwid, wid, stat, wear FROM owo_user_weapon
             WHERE guild_id = ? AND uid = ? AND pid = ? LIMIT 1`,
            [guildId, userId, s.pid]
        );

        let weaponDetail = null;
        if (wep) {
            const WeaponCls = getWeaponById(wep.wid);
            const inst = WeaponCls ? new WeaponCls(null, null, true) : null;
            const [rank, value, wearId] = String(wep.stat || '').split(' ');

            // Passives
            const [passiveRows] = await pool.execute(
                'SELECT wpid, stat FROM owo_user_weapon_passive WHERE guild_id = ? AND uwid = ?',
                [guildId, wep.uwid]
            );
            const passives = passiveRows.map(p => {
                for (const [name, PCls] of Object.entries(PASSIVE_CLASSES)) {
                    try {
                        const pi = new PCls(null, true);
                        if (pi.id === p.wpid) return { name, id: p.wpid, quality: Number(p.stat) || 0 };
                    } catch { /* skip */ }
                }
                return { name: `passive#${p.wpid}`, id: p.wpid, quality: Number(p.stat) || 0 };
            });

            weaponDetail = {
                uwid: Number(wep.uwid),
                weaponId: wep.wid,
                name: inst?.name,
                emoji: inst?.defaultEmoji || '🗡️',
                rank,
                stat: Number(value) || 0,
                wearId: Number(wearId) || 1,
                wearName: WEAR_NAMES[Number(wearId) || 1] || 'Worn',
                passives,
            };
        }

        animals.push({
            pos: Number(s.pos),
            pid: Number(s.pid),
            name: s.name,
            nickname: s.nickname || null,
            count: Number(s.count),
            xp: Number(s.xp) || 0,
            ispet: s.ispet === 1,
            rank: s.rank,
            stats: {
                hp: Number(s.hp) || 0,
                att: Number(s.att) || 0,
                pr: Number(s.pr) || 0,
                wp: Number(s.wp) || 0,
                mag: Number(s.mag) || 0,
                mr: Number(s.mr) || 0,
            },
            weapon: weaponDetail,
        });
    }

    return {
        pgid: Number(team.pgid),
        tname: team.tname,
        win: Number(team.win) || 0,
        lose: Number(team.lose) || 0,
        streak: Number(team.streak) || 0,
        highestStreak: Number(team.highest_streak) || 0,
        animals,
    };
}

// ── Rename animal (nickname) ──────────────────────────────────────

export async function renameAnimal(guildId, userId, animalName, nickname) {
    const n = String(nickname || '').slice(0, 35).trim();
    if (!n) return { error: 'Empty nickname.' };
    const [r] = await pool.execute(
        'UPDATE owo_animal SET nickname = ? WHERE guild_id = ? AND id = ? AND name = ?',
        [n, guildId, userId, animalName]
    );
    if (r.affectedRows === 0) return { error: `You don't own \`${animalName}\`.` };
    return { animalName, nickname: n };
}
