/*
 * Battles: settings, CPU battles, and member-vs-member duels with bets held in escrow.
 *
 * Duel lifecycle (critter_duels, one row per pair, user1 < user2 as big integers):
 *   idle -> openChallenge (challenger's stake taken, pending, expires in 75 s)
 *        -> acceptChallenge (opponent's stake taken, fighting, expires in 300 s) -> settle -> idle
 *   pending/fighting -> cancelChallenge (decline, withdraw, timeout, team gone) -> idle, stakes refunded
 *   The sweeper (sweepExpiredDuels) refunds any pending/fighting row past expires_at.
 */
import { q, T, withTx, CritterError } from './db.js';
import { BATTLE_BET_CAP, ESCROW_PENDING_SECONDS, ESCROW_FIGHTING_SECONDS, formatAcorns } from './constants.js';
import { BATTLE_REWARD } from './data/economy.js';
import {
    simulateBattle, generateCpuTeam, splitLogFrames, parseSettingsText, BATTLE_SETTINGS_DEFAULTS, SettingsError, SPEED_NAMES,
} from './rules/battle-engine.js';
import { orderPair } from './rules/misc-rules.js';
import { randInt } from './rules/rng.js';
import { credit, debit, lockLimits, bookAllowance, readAllowance, audit } from './store.js';
import { loadBattleTeam, recordTeamResult } from './teams.js';
import { recordKills, rollCrateDrop } from './weapons.js';
import { bumpQuest } from './quests.js';
import logger from '../../utils/logger.js';

/* ----------------------------------------------------------------------------------------------- settings */

export async function getBattleSettings(guildId, userId) {
    const [r] = await q(`SELECT display, speed, logs FROM ${T('battle_settings')} WHERE guild_id = ? AND user_id = ?`, [String(guildId), String(userId)]);
    if (!r) return { ...BATTLE_SETTINGS_DEFAULTS, speedName: SPEED_NAMES[0] };
    const s = { display: r.display === 'compact' ? 'compact' : 'text', speed: Math.max(0, Math.min(2, Number(r.speed) || 0)), logs: !!r.logs };
    return { ...s, speedName: SPEED_NAMES[s.speed] };
}

/**
 * Update settings from a patch ({ display, speed, logs }) or text ("display=compact speed=short logs=on").
 * Errors: UNAVAILABLE, BAD_VALUE, BAD_NAME, BAD_SYNTAX.
 */
export async function setBattleSettings(guildId, userId, patchOrText) {
    let patch = patchOrText;
    try {
        if (typeof patchOrText === 'string') patch = parseSettingsText(patchOrText);
        else {
            const text = Object.entries(patchOrText || {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join(' ');
            patch = parseSettingsText(text);
        }
    } catch (err) {
        if (err instanceof SettingsError) throw new CritterError(err.code, err.message);
        throw err;
    }
    const cur = await getBattleSettings(guildId, userId);
    const next = { display: patch.display ?? cur.display, speed: patch.speed ?? cur.speed, logs: patch.logs ?? cur.logs };
    await q(`INSERT INTO ${T('battle_settings')} (guild_id, user_id, display, speed, logs) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE display = VALUES(display), speed = VALUES(speed), logs = VALUES(logs)`,
        [String(guildId), String(userId), next.display, next.speed, next.logs ? 1 : 0]);
    return { ...next, speedName: SPEED_NAMES[next.speed] };
}

/* ----------------------------------------------------------------------------------------------- CPU battle */

async function payWinner(g, u, rng) {
    const amount = randInt(rng, BATTLE_REWARD.min, BATTLE_REWARD.max);
    const balance = await withTx(conn => credit(conn, g, u, amount));
    try { await bumpQuest(g, u, 'battle', 1); } catch (e) { logger.warn('[critters] battle quest bump failed', { error: e.message }); }
    return { userId: u, amount, balance };
}

/**
 * Battle a generated CPU team. Errors: EMPTY_TEAM.
 * @returns {{ result, frames, settings, playerTeam, cpuTeam: { name, members }, outcome: 'win'|'loss'|'draw', record, reward, crateDrop }}
 */
export async function battleCpu(guildId, userId, { rng = Math.random, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    const mine = await loadBattleTeam(g, u);
    if (!mine) throw new CritterError('EMPTY_TEAM', 'Build a team first: add a critter to your team.');
    const settings = await getBattleSettings(g, u);
    const cpu = generateCpuTeam(mine.combatants, rng);
    const result = simulateBattle(mine.combatants, cpu.members, { rng, nameA: mine.team.name, nameB: cpu.name });
    await recordKills(result.kills.filter(k => k.side === 'team1'));
    const outcome = result.winner === 'team1' ? 'win' : result.winner === 'team2' ? 'loss' : 'draw';
    const record = await recordTeamResult(mine.team.teamId, outcome);
    const reward = outcome === 'win' ? await payWinner(g, u, rng) : null;
    let crateDrop = null;
    try { crateDrop = await rollCrateDrop(g, u, { rng, now }); } catch (e) { logger.warn('[critters] crate drop failed', { error: e.message }); }
    return {
        result, frames: splitLogFrames(result.log, settings.speed), settings,
        playerTeam: mine.team, cpuTeam: { name: cpu.name, members: cpu.members }, outcome, record, reward, crateDrop,
    };
}

/* ----------------------------------------------------------------------------------------------- duels */

const LIVE = ['pending', 'fighting'];

function rowShape(r) {
    return r && {
        guildId: r.guild_id, user1: r.user1, user2: r.user2, sender: r.sender, receiver: r.sender === r.user1 ? r.user2 : r.user1,
        bet: Number(r.bet), status: r.status, escrowSender: Number(r.escrow_sender), escrowReceiver: Number(r.escrow_receiver),
        expiresAt: r.expires_at, channelId: r.channel_id, messageId: r.message_id,
        wins1: Number(r.wins1), wins2: Number(r.wins2), ties: Number(r.ties),
    };
}

async function lockPair(conn, g, a, b) {
    const [user1, user2] = orderPair(a, b);
    await q(`INSERT IGNORE INTO ${T('duels')} (guild_id, user1, user2, sender, status) VALUES (?, ?, ?, ?, 'idle')`, [g, user1, user2, user1], conn);
    const [r] = await q(`SELECT * FROM ${T('duels')} WHERE guild_id = ? AND user1 = ? AND user2 = ? FOR UPDATE`, [g, user1, user2], conn);
    return rowShape(r);
}

/** Refund whatever a row holds and set it idle (inside a transaction). Idempotent. */
async function refundRow(conn, row) {
    if (row.escrowSender > 0) await credit(conn, row.guildId, row.sender, row.escrowSender);
    if (row.escrowReceiver > 0) await credit(conn, row.guildId, row.receiver, row.escrowReceiver);
    await q(`UPDATE ${T('duels')} SET status = 'idle', escrow_sender = 0, escrow_receiver = 0, bet = 0, expires_at = NULL WHERE guild_id = ? AND user1 = ? AND user2 = ?`,
        [row.guildId, row.user1, row.user2], conn);
    return { sender: row.escrowSender, receiver: row.escrowReceiver };
}

const headToHeadOf = (row, challengerId) => {
    if (!row) return { challengerWins: 0, opponentWins: 0, ties: 0 };
    const cIs1 = row.user1 === String(challengerId);
    return { challengerWins: cIs1 ? row.wins1 : row.wins2, opponentWins: cIs1 ? row.wins2 : row.wins1, ties: row.ties };
};

/** Head-to-head record from a's point of view: { challengerWins, opponentWins, ties }. */
export async function headToHead(guildId, a, b) {
    const [user1, user2] = orderPair(a, b);
    const [r] = await q(`SELECT * FROM ${T('duels')} WHERE guild_id = ? AND user1 = ? AND user2 = ?`, [String(guildId), user1, user2]);
    return headToHeadOf(rowShape(r), a);
}

/**
 * Validate a duel before posting it (read-only). Errors: SELF, BOT, BAD_BET, BET_CAP, EMPTY_TEAM,
 * OPPONENT_EMPTY_TEAM, SEND_CAP, RECEIVE_CAP.
 */
export async function checkChallenge({ guildId, challengerId, opponentId, bet = 0, opponentIsBot = false, opponentName = null }) {
    const g = String(guildId); const c = String(challengerId); const o = String(opponentId);
    if (c === o) throw new CritterError('SELF', 'You cannot battle yourself.');
    if (opponentIsBot) throw new CritterError('BOT', 'Bots do not battle.');
    const b = Number(bet || 0);
    if (!Number.isSafeInteger(b) || b < 0) throw new CritterError('BAD_BET', 'The bet must be a whole number of acorns.');
    if (b > BATTLE_BET_CAP) throw new CritterError('BET_CAP', `The most you can bet is ${formatAcorns(BATTLE_BET_CAP)}.`, { cap: BATTLE_BET_CAP });
    if (!(await loadBattleTeam(g, c))) throw new CritterError('EMPTY_TEAM', 'Build a team first: add a critter to your team.');
    if (!(await loadBattleTeam(g, o))) throw new CritterError('OPPONENT_EMPTY_TEAM', `${opponentName || 'They'} do not have a team yet.`);
    if (b > 0) {
        const mine = await readAllowance(null, g, c);
        if (mine.sendLeft < b) throw new CritterError('SEND_CAP', `You can only send ${formatAcorns(mine.sendLeft)} more today.`, { remaining: mine.sendLeft });
        const theirs = await readAllowance(null, g, o);
        if (theirs.receiveLeft < b) throw new CritterError('RECEIVE_CAP', `${opponentName || 'They'} can only receive ${formatAcorns(theirs.receiveLeft)} more today.`, { remaining: theirs.receiveLeft });
    }
    return { bet: b, headToHead: await headToHead(g, c, o) };
}

/**
 * Open a challenge: validates (checkChallenge), refunds any expired live row of either member, refuses when
 * either is in a live duel, takes the challenger's stake and marks the pair pending for 75 s.
 * Errors: all of checkChallenge, BUSY, INSUFFICIENT_FUNDS.
 */
export async function openChallenge({ guildId, challengerId, opponentId, bet = 0, channelId = null, opponentIsBot = false, opponentName = null, now = new Date() }) {
    const g = String(guildId); const c = String(challengerId); const o = String(opponentId);
    const checked = await checkChallenge({ guildId: g, challengerId: c, opponentId: o, bet, opponentIsBot, opponentName });
    const b = checked.bet;
    return withTx(async (conn) => {
        const live = await q(`SELECT * FROM ${T('duels')} WHERE guild_id = ? AND status IN (?) AND (user1 IN (?, ?) OR user2 IN (?, ?)) FOR UPDATE`, [g, LIVE, c, o, c, o], conn);
        for (const r of live.map(rowShape)) {
            if (r.expiresAt && new Date(r.expiresAt).getTime() <= now.getTime()) await refundRow(conn, r);
            else throw new CritterError('BUSY', 'One of you is already in a battle challenge. Finish or cancel it first.');
        }
        const row = await lockPair(conn, g, c, o);
        if (b > 0 && !(await debit(conn, g, c, b))) throw new CritterError('INSUFFICIENT_FUNDS', `You need ${formatAcorns(b)} to make that bet.`, { needed: b });
        const expiresAt = new Date(now.getTime() + ESCROW_PENDING_SECONDS * 1000);
        await q(`UPDATE ${T('duels')} SET sender = ?, bet = ?, status = 'pending', escrow_sender = ?, escrow_receiver = 0, expires_at = ?, channel_id = ?, message_id = NULL, updated_at = NOW()
                 WHERE guild_id = ? AND user1 = ? AND user2 = ?`, [c, b, b, expiresAt, channelId, g, row.user1, row.user2], conn);
        return { challengerId: c, opponentId: o, bet: b, pot: b * 2, expiresAt, headToHead: headToHeadOf(row, c) };
    });
}

/** Save the challenge message id (so the sweeper can edit it). */
export async function setChallengeMessage(guildId, a, b, messageId) {
    const [user1, user2] = orderPair(a, b);
    await q(`UPDATE ${T('duels')} SET message_id = ? WHERE guild_id = ? AND user1 = ? AND user2 = ?`, [String(messageId), String(guildId), user1, user2]);
}

/**
 * Pending challenge involving a member, for answering from chat (`owo ab` / `owo db`) or the buttons.
 * Returns the row (challengerId/opponentId) or null. With channelId, a challenge from another channel is refused
 * (code WRONG_CHANNEL).
 */
export async function findPendingChallenge(guildId, userId, { channelId = null } = {}) {
    const u = String(userId);
    const [r] = await q(`SELECT * FROM ${T('duels')} WHERE guild_id = ? AND status = 'pending' AND (user1 = ? OR user2 = ?) ORDER BY updated_at DESC LIMIT 1`, [String(guildId), u, u]);
    const row = rowShape(r);
    if (!row) return null;
    if (channelId && row.channelId && String(row.channelId) !== String(channelId)) throw new CritterError('WRONG_CHANNEL', 'Answer that challenge in the channel it was made in.');
    return { ...row, challengerId: row.sender, opponentId: row.receiver };
}

/** Cancel (decline, withdraw, timeout): refunds held stakes and idles the pair. Idempotent. */
export async function cancelChallenge(guildId, a, b, { reason = 'cancelled' } = {}) {
    const g = String(guildId);
    return withTx(async (conn) => {
        const row = await lockPair(conn, g, a, b);
        if (!LIVE.includes(row.status)) return { reason, refunded: { sender: 0, receiver: 0 }, row };
        const refunded = await refundRow(conn, row);
        return { reason, refunded, row };
    });
}

/** Settle a fighting duel (inside its own transaction). winnerId null = draw. */
async function settleDuel(g, challengerId, opponentId, winnerId) {
    return withTx(async (conn) => {
        const row = await lockPair(conn, g, challengerId, opponentId);
        if (row.status !== 'fighting') throw new CritterError('NOT_FIGHTING', 'That battle is no longer running.');
        const pot = row.escrowSender + row.escrowReceiver;
        if (!winnerId) {
            await refundRow(conn, row);
            await q(`UPDATE ${T('duels')} SET ties = ties + 1 WHERE guild_id = ? AND user1 = ? AND user2 = ?`, [g, row.user1, row.user2], conn);
            return { draw: true, paid: 0, returned: pot };
        }
        const w = String(winnerId);
        const loser = w === row.user1 ? row.user2 : row.user1;
        if (pot > 0) {
            await credit(conn, g, w, pot);
            const stake = row.bet;
            const limits = await lockLimits(conn, g, [w, loser]);
            await bookAllowance(conn, g, loser, 'sent', stake, { enforce: false, limits });
            await bookAllowance(conn, g, w, 'received', stake, { enforce: false, limits });
            await audit(conn, g, loser, w, stake, 'bet');
        }
        await q(`UPDATE ${T('duels')} SET status = 'idle', escrow_sender = 0, escrow_receiver = 0, bet = 0, expires_at = NULL,
                 wins1 = wins1 + ?, wins2 = wins2 + ? WHERE guild_id = ? AND user1 = ? AND user2 = ?`,
            [w === row.user1 ? 1 : 0, w === row.user2 ? 1 : 0, g, row.user1, row.user2], conn);
        return { draw: false, paid: pot, winnerId: w, loserId: loser };
    });
}

/**
 * The opponent accepts: re-checks allowances, takes the opponent's stake, reloads both teams, fights, records
 * kills and W/L for both teams, settles the escrow, pays the winner's battle reward and rolls the challenger's
 * daily crate. Any refusal cancels and refunds first.
 * Errors: NO_CHALLENGE, NOT_OPPONENT, SEND_CAP, RECEIVE_CAP, OPPONENT_SHORT, TEAM_GONE.
 * @returns {{ result, frames, settings, challengerTeam, opponentTeam, winnerId|null, outcome, bet, settlement,
 *             payoutFailed, reward, headToHead, crateDrop }}
 */
export async function acceptChallenge({ guildId, challengerId, opponentId, rng = Math.random, now = new Date(), challengerName = null, opponentName = null }) {
    const g = String(guildId); const c = String(challengerId); const o = String(opponentId);
    const [user1, user2] = orderPair(c, o);
    const [raw] = await q(`SELECT * FROM ${T('duels')} WHERE guild_id = ? AND user1 = ? AND user2 = ?`, [g, user1, user2]);
    const pending = rowShape(raw);
    if (!pending || pending.status !== 'pending') throw new CritterError('NO_CHALLENGE', 'That challenge is no longer open.');
    if (pending.sender !== c) throw new CritterError('NOT_OPPONENT', 'Only the challenged member can accept.');
    const bet = pending.bet;
    const fail = async (code, message, data) => {
        await cancelChallenge(g, c, o, { reason: code });
        throw new CritterError(code, message, { ...data, refunded: true });
    };
    if (bet > 0) {
        const theirs = await readAllowance(null, g, o);
        if (theirs.sendLeft < bet) await fail('SEND_CAP', `${opponentName || 'The opponent'} can only send ${formatAcorns(theirs.sendLeft)} more today. The bet was returned.`, { remaining: theirs.sendLeft });
        const mine = await readAllowance(null, g, c);
        if (mine.receiveLeft < bet) await fail('RECEIVE_CAP', `${challengerName || 'The challenger'} can only receive ${formatAcorns(mine.receiveLeft)} more today. The bet was returned.`, { remaining: mine.receiveLeft });
    }
    const accepted = await withTx(async (conn) => {
        const row = await lockPair(conn, g, c, o);
        if (row.status !== 'pending' || row.sender !== c) return { ok: false, code: 'NO_CHALLENGE' };
        if (bet > 0 && !(await debit(conn, g, o, bet))) return { ok: false, code: 'OPPONENT_SHORT' };
        const expiresAt = new Date(now.getTime() + ESCROW_FIGHTING_SECONDS * 1000);
        await q(`UPDATE ${T('duels')} SET status = 'fighting', escrow_receiver = ?, expires_at = ?, updated_at = NOW() WHERE guild_id = ? AND user1 = ? AND user2 = ?`, [bet, expiresAt, g, row.user1, row.user2], conn);
        return { ok: true };
    });
    if (!accepted.ok) {
        if (accepted.code === 'OPPONENT_SHORT') await fail('OPPONENT_SHORT', `${opponentName || 'The opponent'} cannot cover the ${formatAcorns(bet)} bet. Both stakes were returned.`, {});
        throw new CritterError('NO_CHALLENGE', 'That challenge is no longer open.');
    }
    const ca = await loadBattleTeam(g, c);
    const ob = await loadBattleTeam(g, o);
    if (!ca || !ob) await fail('TEAM_GONE', 'One of the teams is empty now, so the battle is off. Any bets were returned.', {});
    const settings = await getBattleSettings(g, c);
    const result = simulateBattle(ca.combatants, ob.combatants, { rng, nameA: ca.team.name, nameB: ob.team.name });
    await recordKills(result.kills);
    const winnerId = result.winner === 'team1' ? c : result.winner === 'team2' ? o : null;
    if (winnerId) {
        await recordTeamResult(ca.team.teamId, winnerId === c ? 'win' : 'loss');
        await recordTeamResult(ob.team.teamId, winnerId === o ? 'win' : 'loss');
    }
    let settlement = null;
    let payoutFailed = false;
    try {
        settlement = await settleDuel(g, c, o, winnerId);
    } catch (err) {
        payoutFailed = true; // the sweeper refunds the fighting row once it expires
        logger.warn('[critters] duel settle failed', { guildId: g, error: err.message });
    }
    const reward = winnerId ? await payWinner(g, winnerId, rng) : null;
    let crateDrop = null;
    try { crateDrop = await rollCrateDrop(g, c, { rng, now }); } catch (e) { logger.warn('[critters] crate drop failed', { error: e.message }); }
    return {
        result, frames: splitLogFrames(result.log, settings.speed), settings,
        challengerTeam: ca.team, opponentTeam: ob.team, winnerId, outcome: result.winner, bet, settlement, payoutFailed, reward,
        headToHead: await headToHead(g, c, o), crateDrop,
    };
}

/**
 * Refund every pending/fighting duel past expires_at (up to `limit`), each re-checked under lock.
 * Returns the refunded rows (with channelId and messageId so the caller can edit the challenge message).
 */
export async function sweepExpiredDuels({ limit = 100, now = new Date() } = {}) {
    const due = await q(`SELECT guild_id, user1, user2 FROM ${T('duels')} WHERE status IN (?) AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`, [LIVE, now, limit]);
    const out = [];
    for (const d of due) {
        try {
            const res = await withTx(async (conn) => {
                const [r] = await q(`SELECT * FROM ${T('duels')} WHERE guild_id = ? AND user1 = ? AND user2 = ? FOR UPDATE`, [d.guild_id, d.user1, d.user2], conn);
                const row = rowShape(r);
                if (!row || !LIVE.includes(row.status) || !row.expiresAt || new Date(row.expiresAt).getTime() > now.getTime()) return null;
                const refunded = await refundRow(conn, row);
                return { ...row, refunded };
            });
            if (res) out.push(res);
        } catch (err) {
            logger.warn('[critters] duel sweep failed', { guildId: d.guild_id, error: err.message });
        }
    }
    return out;
}
