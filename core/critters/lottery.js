/*
 * Nightly lottery, one round per server. Each acorn entered is one ticket. The draw runs at local midnight
 * (jobs.js); with fewer than 2 entrants the round rolls over and keeps its entries.
 */
import { q, T, withTx, CritterError } from './db.js';
import { formatAcorns } from './constants.js';
import { LOTTERY } from './data/economy.js';
import { lotteryEntryAmount, pickLotteryWinner, winChancePct } from './rules/misc-rules.js';
import { nextLocalMidnight } from './rules/time.js';
import { readWallet, debit, credit } from './store.js';

async function lockRound(conn, g, now) {
    await q(`INSERT IGNORE INTO ${T('lottery_rounds')} (guild_id, round_no, draw_at) VALUES (?, 1, ?)`, [g, nextLocalMidnight(now)], conn);
    const [r] = await q(`SELECT * FROM ${T('lottery_rounds')} WHERE guild_id = ? FOR UPDATE`, [g], conn);
    return r;
}

async function potOf(conn, g, roundNo) {
    const [p] = await q(`SELECT COALESCE(SUM(amount), 0) AS pot, COUNT(*) AS players FROM ${T('lottery_entries')} WHERE guild_id = ? AND round_no = ? AND amount > 0`, [g, roundNo], conn);
    return { pot: Number(p.pot), players: Number(p.players) };
}

/**
 * Enter: amount (whole number) or all. Errors: BAD_AMOUNT, CAP_REACHED, INSUFFICIENT_FUNDS, NOTHING_TO_ADD.
 * @returns {{ added, total, pot, jackpot, players, chancePct, drawAt, trimmed, cap, balance }}
 */
export async function enterLottery(guildId, userId, { amount = null, all = false, channelId = null, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    if (!all) {
        const n = Number(amount);
        if (!Number.isSafeInteger(n) || n < 1) throw new CritterError('BAD_AMOUNT', 'Enter a whole number of acorns, or all.');
    }
    return withTx(async (conn) => {
        const round = await lockRound(conn, g, now);
        const w = await readWallet(conn, g, u, { lock: true });
        const [e] = await q(`SELECT amount, round_no FROM ${T('lottery_entries')} WHERE guild_id = ? AND user_id = ? FOR UPDATE`, [g, u], conn);
        const current = e && Number(e.round_no) === Number(round.round_no) ? Number(e.amount) : 0;
        if (current >= LOTTERY.capPerRound) throw new CritterError('CAP_REACHED', `You already have the most tickets allowed this round (${formatAcorns(LOTTERY.capPerRound)}).`, { cap: LOTTERY.capPerRound });
        if (!all && Number(amount) > w.balance) throw new CritterError('INSUFFICIENT_FUNDS', `You only have ${formatAcorns(w.balance)}.`, { balance: w.balance });
        const { add, trimmed } = lotteryEntryAmount({ requested: amount, all, balance: w.balance, current, cap: LOTTERY.capPerRound });
        if (add <= 0) throw new CritterError('NOTHING_TO_ADD', 'You have no acorns to enter.');
        await debit(conn, g, u, add);
        await q(`INSERT INTO ${T('lottery_entries')} (guild_id, user_id, amount, round_no, channel_id) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE amount = IF(round_no = VALUES(round_no), amount + VALUES(amount), VALUES(amount)), round_no = VALUES(round_no), channel_id = VALUES(channel_id)`,
            [g, u, add, round.round_no, channelId], conn);
        if (channelId) await q(`UPDATE ${T('lottery_rounds')} SET announce_channel = ? WHERE guild_id = ?`, [String(channelId), g], conn);
        const total = current + add;
        const { pot, players } = await potOf(conn, g, round.round_no);
        return {
            added: add, total, pot, jackpot: pot + LOTTERY.houseTopUp, players, chancePct: winChancePct(total, pot),
            drawAt: round.draw_at, trimmed, cap: LOTTERY.capPerRound, balance: w.balance - add,
        };
    });
}

/** Status: { entry, pot, jackpot, players, chancePct, drawAt, cap, last: { winnerId, pot, participants, drawnAt } | null } */
export async function lotteryStatus(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    const [round] = await q(`SELECT * FROM ${T('lottery_rounds')} WHERE guild_id = ?`, [g]);
    if (!round) return { entry: 0, pot: 0, jackpot: LOTTERY.houseTopUp, players: 0, chancePct: 0, drawAt: nextLocalMidnight(new Date()), cap: LOTTERY.capPerRound, last: null };
    const [e] = await q(`SELECT amount, round_no FROM ${T('lottery_entries')} WHERE guild_id = ? AND user_id = ?`, [g, u]);
    const entry = e && Number(e.round_no) === Number(round.round_no) ? Number(e.amount) : 0;
    const { pot, players } = await potOf(null, g, round.round_no);
    return {
        entry, pot, jackpot: pot + LOTTERY.houseTopUp, players, chancePct: winChancePct(entry, pot), drawAt: round.draw_at, cap: LOTTERY.capPerRound,
        last: round.last_drawn_at ? { winnerId: round.last_winner, pot: Number(round.last_pot), participants: Number(round.last_participants), drawnAt: round.last_drawn_at } : null,
    };
}

/** Guild ids whose round is due (draw_at <= now), oldest first. */
export async function dueLotteryGuilds({ limit = 50, now = new Date() } = {}) {
    const rows = await q(`SELECT guild_id FROM ${T('lottery_rounds')} WHERE draw_at <= ? ORDER BY draw_at LIMIT ?`, [now, limit]);
    return rows.map(r => r.guild_id);
}

/**
 * Draw one guild's round if due. Idempotent: the round row is locked and moved forward in the same transaction
 * that pays. Returns null (not due) or
 *   { kind: 'empty' }                                       nobody entered; next draw scheduled
 *   { kind: 'rollover', soloUserId, channelId }             one entrant; entries kept, next midnight
 *   { kind: 'won', winnerId, pot, prize, participants, chancePct, roundNo, channelId }
 */
export async function drawLottery(guildId, { rng = Math.random, now = new Date() } = {}) {
    const g = String(guildId);
    return withTx(async (conn) => {
        const [round] = await q(`SELECT * FROM ${T('lottery_rounds')} WHERE guild_id = ? FOR UPDATE`, [g], conn);
        if (!round || new Date(round.draw_at).getTime() > now.getTime()) return null;
        const next = nextLocalMidnight(now);
        const entries = (await q(`SELECT user_id, amount FROM ${T('lottery_entries')} WHERE guild_id = ? AND round_no = ? AND amount > 0 ORDER BY user_id`, [g, round.round_no], conn))
            .map(e => ({ userId: e.user_id, amount: Number(e.amount) }));
        if (entries.length < LOTTERY.minEntrants) {
            await q(`UPDATE ${T('lottery_rounds')} SET draw_at = ? WHERE guild_id = ?`, [next, g], conn);
            return entries.length === 0 ? { kind: 'empty', channelId: round.announce_channel }
                : { kind: 'rollover', soloUserId: entries[0].userId, amount: entries[0].amount, channelId: round.announce_channel, nextDrawAt: next };
        }
        const pot = entries.reduce((s, e) => s + e.amount, 0);
        const winner = pickLotteryWinner(entries, rng);
        const prize = pot + LOTTERY.houseTopUp;
        await credit(conn, g, winner.userId, prize);
        await q(`DELETE FROM ${T('lottery_entries')} WHERE guild_id = ?`, [g], conn);
        await q(`UPDATE ${T('lottery_rounds')} SET round_no = round_no + 1, draw_at = ?, last_winner = ?, last_pot = ?, last_participants = ?, last_drawn_at = ? WHERE guild_id = ?`,
            [next, winner.userId, prize, entries.length, now, g], conn);
        return {
            kind: 'won', winnerId: winner.userId, pot, prize, participants: entries.length, chancePct: winChancePct(winner.amount, pot),
            roundNo: Number(round.round_no), channelId: round.announce_channel, nextDrawAt: next,
        };
    });
}
