/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 * Port of upstream OwO Bot's lottery (src/commands/commandList/gamble/lottery.js, Copyright (C)
 * Christopher Thai), per server, with the nightly draw upstream ran out-of-repo built in.
 *
 * Tables
 *   owo_lottery        (guild_id, id) one row per member: amount = cowoncy in the current round,
 *                      valid = 1 while it counts, channel = where they last bought.
 *   owo_lottery_round  (migration 311) one row per server: when the next draw is due, where to
 *                      announce it, and the last result. Persisted so a restart never skips or
 *                      double-runs a draw — jobs/owo-lottery-draw.js picks up anything overdue on boot.
 *
 * Rules (upstream): every cowoncy entered is one ticket, max 250,000 per member per round, the pot
 * pays out pot + 500 to one weighted-random winner at midnight. Local rule: a round needs at least
 * two players or it rolls over to the next night (see LOTTERY_MIN_ENTRANTS).
 */
import pool from '../../utils/db.js';
import { withTx, OwoUserError } from './tx.js';
import { lockBalancesTx, debitTx, creditTx } from './cowoncy.js';
import {
    LOTTERY_MAX_BET, LOTTERY_HOUSE_BONUS, LOTTERY_MIN_ENTRANTS,
    lotteryAddable, winChance, pickWeightedWinner, nextMidnight,
} from './social-math.js';

async function ensureRoundTx(conn, guildId, channelId) {
    await conn.execute(
        `INSERT INTO owo_lottery_round (guild_id, draw_at, announce_channel) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE announce_channel = COALESCE(VALUES(announce_channel), announce_channel)`,
        [guildId, nextMidnight(), channelId ? String(channelId) : null]
    );
    const [[round]] = await conn.execute('SELECT draw_at FROM owo_lottery_round WHERE guild_id = ?', [guildId]);
    return round;
}

async function potTx(conn, guildId) {
    const [[row]] = await conn.execute(
        'SELECT COALESCE(SUM(amount), 0) AS sum, COUNT(*) AS count FROM owo_lottery WHERE guild_id = ? AND valid = 1 AND amount > 0',
        [guildId]
    );
    return { sum: Number(row?.sum) || 0, count: Number(row?.count) || 0 };
}

/**
 * Put cowoncy into tonight's lottery.
 * @param {number|null} amount  null = "all" (as much as the cap and balance allow)
 */
export async function enterLottery(guildId, userId, amount, channelId) {
    if (amount !== null && (!Number.isSafeInteger(amount) || amount <= 0)) {
        throw new OwoUserError(amount === 0 ? 'You bet... nothing?' : 'Do you understand how lotteries work...?');
    }
    return withTx(async (conn) => {
        const balances = await lockBalancesTx(conn, guildId, [userId]);
        const balance = balances.get(String(userId)) ?? 0;
        const [[mine]] = await conn.execute(
            'SELECT amount FROM owo_lottery WHERE guild_id = ? AND id = ? AND valid = 1 FOR UPDATE',
            [guildId, userId]
        );
        const prevBet = Number(mine?.amount) || 0;
        if (prevBet >= LOTTERY_MAX_BET) {
            throw new OwoUserError(`You can only bet up to **${LOTTERY_MAX_BET.toLocaleString('en-US')}** cowoncy per round!`);
        }
        if (amount !== null && balance < amount) throw new OwoUserError("You don't have enough cowoncy!");
        const add = lotteryAddable({ requested: amount, prevBet, balance });
        if (add <= 0) throw new OwoUserError("You don't have any cowoncy to bet!");

        await debitTx(conn, guildId, userId, add);
        // `amount` is assigned before `valid`, so IF() still sees the old flag: a stale row from a
        // finished round restarts at `add` instead of adding to last round's total.
        await conn.execute(
            `INSERT INTO owo_lottery (guild_id, id, amount, valid, channel) VALUES (?, ?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE amount = IF(valid = 1, amount + VALUES(amount), VALUES(amount)),
                                     valid = 1, channel = VALUES(channel)`,
            [guildId, userId, add, String(channelId || 0)]
        );
        const round = await ensureRoundTx(conn, guildId, channelId);
        const pot = await potTx(conn, guildId);
        const total = prevBet + add;
        return {
            added: add,
            total,
            pot: pot.sum,
            jackpot: pot.sum + LOTTERY_HOUSE_BONUS,
            players: pot.count,
            chance: winChance(total, pot.sum),
            drawAt: new Date(round.draw_at),
            capped: amount !== null && add < amount,
        };
    }, { label: 'lottery-enter' });
}

/** Current round for `owo lottery` with no amount. */
export async function lotteryStatus(guildId, userId) {
    const [[mine]] = await pool.execute(
        'SELECT amount FROM owo_lottery WHERE guild_id = ? AND id = ? AND valid = 1', [guildId, userId]);
    const pot = await potTx(pool, guildId);
    const [[round]] = await pool.execute(
        'SELECT draw_at, last_winner, last_pot, last_participants, last_drawn_at FROM owo_lottery_round WHERE guild_id = ?',
        [guildId]
    );
    const bet = Number(mine?.amount) || 0;
    return {
        bet,
        pot: pot.sum,
        jackpot: pot.sum + LOTTERY_HOUSE_BONUS,
        players: pot.count,
        chance: bet ? winChance(bet, pot.sum) : 0,
        drawAt: round?.draw_at ? new Date(round.draw_at) : nextMidnight(),
        last: round?.last_winner ? {
            winner: round.last_winner,
            pot: Number(round.last_pot) || 0,
            players: Number(round.last_participants) || 0,
            at: round.last_drawn_at ? new Date(round.last_drawn_at) : null,
        } : null,
    };
}

/** Servers whose draw is due (the job's worklist). */
export async function findDueRounds(limit = 50) {
    const n = Math.max(1, Math.min(200, Math.trunc(limit)));
    const [rows] = await pool.execute(
        `SELECT guild_id FROM owo_lottery_round WHERE draw_at <= NOW() ORDER BY draw_at LIMIT ${n}`
    );
    return rows.map(r => r.guild_id);
}

/**
 * Run one server's draw if it is still due. Idempotent: the round row is locked and moved to the
 * next midnight in the same transaction that pays the winner, so two sweeps (or a sweep racing a
 * restart) can never pay twice.
 *
 * @returns {Promise<null | {rolledOver: true, players: number, channelId: string|null}
 *                        | {winnerId: string, pot: number, players: number, chance: number, channelId: string|null}>}
 */
export async function drawRound(guildId, rand = Math.random) {
    return withTx(async (conn) => {
        const [[round]] = await conn.execute(
            'SELECT announce_channel FROM owo_lottery_round WHERE guild_id = ? AND draw_at <= NOW() FOR UPDATE',
            [guildId]
        );
        if (!round) return null;
        const [entries] = await conn.execute(
            `SELECT id, amount, CAST(channel AS CHAR) AS channel FROM owo_lottery
             WHERE guild_id = ? AND valid = 1 AND amount > 0 FOR UPDATE`,
            [guildId]
        );
        const next = nextMidnight();
        const fallbackChannel = round.announce_channel || null;

        if (entries.length < LOTTERY_MIN_ENTRANTS) {
            await conn.execute('UPDATE owo_lottery_round SET draw_at = ? WHERE guild_id = ?', [next, guildId]);
            const only = entries[0];
            return { rolledOver: true, players: entries.length, channelId: only?.channel && only.channel !== '0' ? only.channel : fallbackChannel, soleEntrant: only?.id ?? null };
        }

        const list = entries.map(e => ({ id: String(e.id), amount: Number(e.amount), channel: e.channel }));
        const winner = pickWeightedWinner(list, rand);
        const sum = list.reduce((s, e) => s + e.amount, 0);
        const pot = sum + LOTTERY_HOUSE_BONUS;

        await creditTx(conn, guildId, winner.id, pot);
        await conn.execute('UPDATE owo_lottery SET valid = 0, amount = 0 WHERE guild_id = ? AND valid = 1', [guildId]);
        await conn.execute(
            `UPDATE owo_lottery_round
             SET draw_at = ?, round_no = round_no + 1, last_winner = ?, last_pot = ?,
                 last_participants = ?, last_drawn_at = NOW()
             WHERE guild_id = ?`,
            [next, winner.id, pot, list.length, guildId]
        );
        const channelId = fallbackChannel || (winner.channel && winner.channel !== '0' ? winner.channel : null);
        return { winnerId: winner.id, pot, players: list.length, chance: winChance(winner.amount, sum), channelId };
    }, { label: 'lottery-draw' });
}
