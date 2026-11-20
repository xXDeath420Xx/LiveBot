/*
 * Teams and pets: up to 5 teams of 3 per member, an active team, pet XP and levels, nicknames, equipping gear.
 * A pet is an owned species row (critter_owned.pid); duplicates of a species share one pid.
 */
import { q, T, withTx, CritterError } from './db.js';
import { TEAM_LIMIT, TEAM_SLOTS, TEAM_NAME_MAX, NICKNAME_MAX } from './constants.js';
import { speciesByKey, resolveSpecies } from './data/species.js';
import { petLevel } from './data/economy.js';
import { deriveCombatant, applyRecord } from './rules/battle-engine.js';
import { describeWeapon } from './rules/weapon-rules.js';
import { readWallet } from './store.js';
import { loadWeapons } from './weapons.js';

const teamRow = (r, activeId) => ({
    teamId: Number(r.team_id), name: r.name, wins: Number(r.wins), losses: Number(r.losses), streak: Number(r.streak),
    bestStreak: Number(r.best_streak), active: Number(r.team_id) === Number(activeId),
});

/** A per-member mutex: lock the member's wallet row for the rest of the transaction. */
const lockMember = (conn, g, u) => readWallet(conn, g, u, { lock: true });

async function activeTeamId(conn, g, u) {
    const [a] = await q(`SELECT team_id FROM ${T('team_active')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
    if (a?.team_id) {
        const [t] = await q(`SELECT team_id FROM ${T('teams')} WHERE team_id = ? AND guild_id = ? AND user_id = ?`, [a.team_id, g, u], conn);
        if (t) return Number(t.team_id);
    }
    return null;
}

async function setActive(conn, g, u, teamId) {
    await q(`INSERT INTO ${T('team_active')} (guild_id, user_id, team_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE team_id = VALUES(team_id)`, [g, u, teamId], conn);
}

async function ownTeam(conn, g, u, teamId) {
    const [t] = await q(`SELECT * FROM ${T('teams')} WHERE team_id = ? AND guild_id = ? AND user_id = ?`, [Number(teamId), g, u], conn);
    if (!t) throw new CritterError('NO_SUCH_TEAM', `You have no team ${teamId}.`);
    return t;
}

async function createTeamTx(conn, g, u, name) {
    const [c] = await q(`SELECT COUNT(*) AS n FROM ${T('teams')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
    const n = Number(c.n);
    if (n >= TEAM_LIMIT) throw new CritterError('TEAM_LIMIT', `You already have ${TEAM_LIMIT} teams.`);
    const clean = String(name || '').trim().slice(0, TEAM_NAME_MAX) || `Team ${n + 1}`;
    const r = await q(`INSERT INTO ${T('teams')} (guild_id, user_id, name) VALUES (?, ?, ?)`, [g, u, clean], conn);
    const teamId = Number(r.insertId);
    const becameActive = (await activeTeamId(conn, g, u)) == null;
    if (becameActive) await setActive(conn, g, u, teamId);
    return { teamId, name: clean, active: becameActive };
}

export async function listTeams(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    const active = await activeTeamId(null, g, u);
    const rows = await q(`SELECT t.*, (SELECT COUNT(*) FROM ${T('team_slots')} s WHERE s.team_id = t.team_id) AS size FROM ${T('teams')} t WHERE t.guild_id = ? AND t.user_id = ? ORDER BY t.team_id`, [g, u]);
    return rows.map(r => ({ ...teamRow(r, active), size: Number(r.size) }));
}

/** Create a team (max 5; the first one becomes active). Errors: TEAM_LIMIT. */
export async function createTeam(guildId, userId, name = '') {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => { await lockMember(conn, g, u); return createTeamTx(conn, g, u, name); });
}

async function slotsOf(conn, teamId) {
    return q(`SELECT s.pos, s.pid, o.species, o.nickname, o.xp, o.count FROM ${T('team_slots')} s
              LEFT JOIN ${T('owned')} o ON o.pid = s.pid WHERE s.team_id = ? ORDER BY s.pos`, [teamId], conn);
}

/**
 * Team view (the active team, or a team id). Errors: NO_TEAM, NO_SUCH_TEAM.
 * @returns {{ teamId, name, wins, losses, streak, bestStreak, active, slots: [{ pos, pid, species, nickname, xp, level, combat, weapon }] }}
 */
export async function getTeam(guildId, userId, teamId = null, conn = null) {
    const g = String(guildId); const u = String(userId);
    const active = await activeTeamId(conn, g, u);
    const id = teamId ?? active;
    if (id == null) throw new CritterError('NO_TEAM', 'You do not have a team yet. Add a critter to start one.');
    const t = await ownTeam(conn, g, u, id);
    const slots = await slotsOf(conn, Number(t.team_id));
    const pids = slots.map(s => Number(s.pid)).filter(Boolean);
    const weapons = pids.length ? await loadWeapons(conn, 'pet_pid IN (?)', [pids]) : [];
    const byPid = new Map(weapons.map(w => [w.petPid, w]));
    return {
        ...teamRow(t, active),
        slots: slots.filter(s => speciesByKey(s.species)).map(s => {
            const species = speciesByKey(s.species);
            const weapon = byPid.get(Number(s.pid)) || null;
            const level = petLevel(s.xp);
            return {
                pos: Number(s.pos), pid: Number(s.pid), species, nickname: s.nickname || null, xp: Number(s.xp), level,
                combat: deriveCombatant({ species, weapon, nickname: s.nickname, level, pid: Number(s.pid) }),
                weapon: weapon ? describeWeapon(weapon) : null,
            };
        }),
    };
}

/** Battle-ready active team: { team, combatants } or null when there is no team or it is empty. */
export async function loadBattleTeam(guildId, userId, conn = null) {
    let team;
    try {
        team = await getTeam(guildId, userId, null, conn);
    } catch (err) {
        if (err.code === 'NO_TEAM' || err.code === 'NO_SUCH_TEAM') return null;
        throw err;
    }
    if (!team.slots.length) return null;
    return { team, combatants: team.slots.map(s => s.combat) };
}

/**
 * Add an owned species to the active team (creates "Team 1" when you have none).
 * Errors: UNKNOWN_SPECIES, NOT_OWNED, ALREADY_ON_TEAM, TEAM_FULL.
 */
export async function addToTeam(guildId, userId, speciesQuery) {
    const g = String(guildId); const u = String(userId);
    const species = resolveSpecies(speciesQuery);
    if (!species) throw new CritterError('UNKNOWN_SPECIES', 'There is no critter by that name.');
    return withTx(async (conn) => {
        await lockMember(conn, g, u);
        const [own] = await q(`SELECT pid, count FROM ${T('owned')} WHERE guild_id = ? AND user_id = ? AND species = ?`, [g, u, species.key], conn);
        if (!own || Number(own.count) < 1) throw new CritterError('NOT_OWNED', `You do not have a ${species.name}.`);
        let teamId = await activeTeamId(conn, g, u);
        let created = false;
        if (teamId == null) { teamId = (await createTeamTx(conn, g, u, '')).teamId; created = true; }
        const slots = await q(`SELECT pos, pid FROM ${T('team_slots')} WHERE team_id = ? FOR UPDATE`, [teamId], conn);
        if (slots.some(s => Number(s.pid) === Number(own.pid))) throw new CritterError('ALREADY_ON_TEAM', `${species.name} is already on this team.`);
        if (slots.length >= TEAM_SLOTS) throw new CritterError('TEAM_FULL', `A team holds ${TEAM_SLOTS} critters. Remove one first.`);
        const used = new Set(slots.map(s => Number(s.pos)));
        let pos = 1;
        while (used.has(pos)) pos += 1;
        await q(`INSERT INTO ${T('team_slots')} (team_id, pos, guild_id, user_id, pid) VALUES (?, ?, ?, ?, ?)`, [teamId, pos, g, u, own.pid], conn);
        await q(`UPDATE ${T('owned')} SET is_pet = 1 WHERE pid = ?`, [own.pid], conn);
        return { teamId, pos, species, createdTeam: created };
    });
}

async function activeSlot(conn, g, u, pos) {
    const p = Number(pos);
    if (!Number.isInteger(p) || p < 1 || p > TEAM_SLOTS) throw new CritterError('BAD_POS', `Pick a slot from 1 to ${TEAM_SLOTS}.`);
    const teamId = await activeTeamId(conn, g, u);
    if (teamId == null) throw new CritterError('NO_TEAM', 'You do not have a team yet.');
    const [s] = await q(`SELECT s.pid, o.species FROM ${T('team_slots')} s LEFT JOIN ${T('owned')} o ON o.pid = s.pid WHERE s.team_id = ? AND s.pos = ?`, [teamId, p], conn);
    if (!s) throw new CritterError('EMPTY_SLOT', `Slot ${p} is empty.`);
    return { teamId, pos: p, pid: Number(s.pid), species: speciesByKey(s.species) };
}

/** Remove the critter at a slot of the active team and unequip its weapon. Errors: BAD_POS, NO_TEAM, EMPTY_SLOT. */
export async function removeFromTeam(guildId, userId, pos) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        await lockMember(conn, g, u);
        const s = await activeSlot(conn, g, u, pos);
        await q(`DELETE FROM ${T('team_slots')} WHERE team_id = ? AND pos = ?`, [s.teamId, s.pos], conn);
        const r = await q(`UPDATE ${T('weapons')} SET pet_pid = NULL WHERE pet_pid = ?`, [s.pid], conn);
        const [still] = await q(`SELECT COUNT(*) AS n FROM ${T('team_slots')} WHERE pid = ?`, [s.pid], conn);
        if (Number(still.n) === 0) await q(`UPDATE ${T('owned')} SET is_pet = 0 WHERE pid = ?`, [s.pid], conn);
        return { pos: s.pos, species: s.species, unequipped: r.affectedRows > 0 };
    });
}

export async function switchTeam(guildId, userId, teamId) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        const t = await ownTeam(conn, g, u, teamId);
        await setActive(conn, g, u, Number(t.team_id));
        return { teamId: Number(t.team_id), name: t.name };
    });
}

export async function renameTeam(guildId, userId, teamId, name) {
    const g = String(guildId); const u = String(userId);
    const clean = String(name || '').trim().slice(0, TEAM_NAME_MAX);
    if (!clean) throw new CritterError('BAD_NAME', 'Give the team a name.');
    return withTx(async (conn) => {
        const t = await ownTeam(conn, g, u, teamId);
        await q(`UPDATE ${T('teams')} SET name = ? WHERE team_id = ?`, [clean, t.team_id], conn);
        return { teamId: Number(t.team_id), name: clean };
    });
}

/** Delete a team (not your last one). If it was active, your lowest-numbered other team becomes active. Errors: LAST_TEAM. */
export async function deleteTeam(guildId, userId, teamId) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        await lockMember(conn, g, u);
        const t = await ownTeam(conn, g, u, teamId);
        const others = await q(`SELECT team_id FROM ${T('teams')} WHERE guild_id = ? AND user_id = ? AND team_id <> ? ORDER BY team_id`, [g, u, t.team_id], conn);
        if (!others.length) throw new CritterError('LAST_TEAM', 'You cannot delete your only team.');
        const pids = (await q(`SELECT pid FROM ${T('team_slots')} WHERE team_id = ?`, [t.team_id], conn)).map(r => Number(r.pid));
        await q(`DELETE FROM ${T('team_slots')} WHERE team_id = ?`, [t.team_id], conn);
        await q(`DELETE FROM ${T('teams')} WHERE team_id = ?`, [t.team_id], conn);
        for (const pid of pids) {
            const [still] = await q(`SELECT COUNT(*) AS n FROM ${T('team_slots')} WHERE pid = ?`, [pid], conn);
            if (Number(still.n) === 0) await q(`UPDATE ${T('owned')} SET is_pet = 0 WHERE pid = ?`, [pid], conn);
        }
        let activeId = await activeTeamId(conn, g, u);
        if (activeId == null || activeId === Number(t.team_id)) { activeId = Number(others[0].team_id); await setActive(conn, g, u, activeId); }
        return { deleted: Number(t.team_id), activeTeamId: activeId };
    });
}

/**
 * Equip a weapon on the active team's slot. It leaves any other pet, and any weapon already on this pet comes off.
 * Errors: BAD_POS, NO_TEAM, EMPTY_SLOT, NOT_FOUND.
 */
export async function equipWeapon(guildId, userId, pos, uwid) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        await lockMember(conn, g, u);
        const s = await activeSlot(conn, g, u, pos);
        const [w] = await loadWeapons(conn, 'guild_id = ? AND user_id = ? AND uwid = ? FOR UPDATE', [g, u, Number(uwid)]);
        if (!w) throw new CritterError('NOT_FOUND', `You do not own weapon ${uwid}.`);
        const off = await loadWeapons(conn, 'pet_pid = ? AND uwid <> ?', [s.pid, w.uwid]);
        await q(`UPDATE ${T('weapons')} SET pet_pid = NULL WHERE pet_pid = ? AND uwid <> ?`, [s.pid, w.uwid], conn);
        await q(`UPDATE ${T('weapons')} SET pet_pid = ? WHERE uwid = ?`, [s.pid, w.uwid], conn);
        return { pos: s.pos, species: s.species, weapon: describeWeapon({ ...w, petPid: s.pid }), replaced: off[0] ? describeWeapon(off[0]) : null, movedFromPid: w.petPid && w.petPid !== s.pid ? w.petPid : null };
    });
}

/** Unequip the weapon at a slot. Returns { pos, weapon: described | null } (null = nothing was equipped). */
export async function unequipWeapon(guildId, userId, pos) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        const s = await activeSlot(conn, g, u, pos);
        const [w] = await loadWeapons(conn, 'pet_pid = ?', [s.pid]);
        if (w) await q(`UPDATE ${T('weapons')} SET pet_pid = NULL WHERE uwid = ?`, [w.uwid], conn);
        return { pos: s.pos, species: s.species, weapon: w ? describeWeapon(w) : null };
    });
}

/** Nickname an owned species (max 35 characters; empty clears). Errors: UNKNOWN_SPECIES, NOT_OWNED. */
export async function setNickname(guildId, userId, speciesQuery, nickname) {
    const g = String(guildId); const u = String(userId);
    const species = resolveSpecies(speciesQuery);
    if (!species) throw new CritterError('UNKNOWN_SPECIES', 'There is no critter by that name.');
    const nick = String(nickname || '').trim().slice(0, NICKNAME_MAX) || null;
    const r = await q(`UPDATE ${T('owned')} SET nickname = ? WHERE guild_id = ? AND user_id = ? AND species = ? AND total_caught > 0`, [nick, g, u, species.key]);
    if (r.affectedRows !== 1) {
        const [x] = await q(`SELECT pid FROM ${T('owned')} WHERE guild_id = ? AND user_id = ? AND species = ?`, [g, u, species.key]);
        if (!x) throw new CritterError('NOT_OWNED', `You do not have a ${species.name}.`);
    }
    return { species, nickname: nick };
}

/** Give every critter on the active team `xp` pet XP. Returns null when xp is 0 or there is no team. */
export async function giveTeamXp(guildId, userId, xp) {
    const g = String(guildId); const u = String(userId);
    const amount = Math.floor(Number(xp) || 0);
    if (amount <= 0) return null;
    return withTx(async (conn) => {
        const teamId = await activeTeamId(conn, g, u);
        if (teamId == null) return null;
        const slots = await q(`SELECT s.pid, o.species, o.xp FROM ${T('team_slots')} s JOIN ${T('owned')} o ON o.pid = s.pid WHERE s.team_id = ? ORDER BY s.pos FOR UPDATE`, [teamId], conn);
        if (!slots.length) return null;
        const members = [];
        for (const s of slots) {
            const before = Number(s.xp);
            await q(`UPDATE ${T('owned')} SET xp = xp + ? WHERE pid = ?`, [amount, s.pid], conn);
            members.push({ pid: Number(s.pid), species: speciesByKey(s.species), xpGained: amount, xp: before + amount, level: petLevel(before + amount), leveledUp: petLevel(before + amount) > petLevel(before) });
        }
        return { xp: amount, members };
    });
}

/** Record a battle outcome on a team ('win' | 'loss' | 'draw'). */
export async function recordTeamResult(teamId, outcome, conn = null) {
    if (!teamId || outcome === 'draw') return null;
    const [t] = await q(`SELECT wins, losses, streak, best_streak FROM ${T('teams')} WHERE team_id = ?${conn ? ' FOR UPDATE' : ''}`, [teamId], conn);
    if (!t) return null;
    const next = applyRecord({ wins: t.wins, losses: t.losses, streak: t.streak, bestStreak: t.best_streak }, outcome);
    await q(`UPDATE ${T('teams')} SET wins = ?, losses = ?, streak = ?, best_streak = ? WHERE team_id = ?`, [next.wins, next.losses, next.streak, next.bestStreak, teamId], conn);
    return next;
}
