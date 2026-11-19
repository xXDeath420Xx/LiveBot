/*
 * Poll betting maths — dependency-free (tests/poll-bets.test.js).
 *
 * Bets are parimutuel: everything wagered on a poll forms one pot; the house keeps a 5% rake and
 * the rest is split between the bets on the winning option in proportion to their stake.
 *   - No votes at all, or a tie for first place -> no winner: every stake is refunded in full.
 *   - Nobody backed the winning option          -> every bet is lost (the pot is the house's).
 * Payouts are floored to whole coins; the rounding dust stays with the house.
 */

export const HOUSE_RAKE = 0.05;

/**
 * The single winning option index, or null when there is no clear winner (no votes, or a tie
 * for the most votes).
 * @param {number[]} voteCounts votes per option index
 */
export function pickWinner(voteCounts) {
    const counts = (voteCounts || []).map(n => Number(n) || 0);
    if (!counts.length) return null;
    const max = Math.max(...counts);
    if (max <= 0) return null;
    const leaders = counts.reduce((acc, n, i) => (n === max ? [...acc, i] : acc), []);
    return leaders.length === 1 ? leaders[0] : null;
}

/**
 * Settle every bet of a poll.
 * @param {{id:any, option_index:number, bet_amount:number}[]} bets  all bets of the poll
 * @param {number|null} winnerIndex  from pickWinner
 * @param {number} [rake]
 * @returns {{ outcomes: Map<any, {status:'won'|'lost'|'refunded', payout:number}>,
 *             totalWagered:number, totalPaid:number, houseProfit:number, refunded:boolean }}
 */
export function settleBets(bets, winnerIndex, rake = HOUSE_RAKE) {
    const list = (bets || []).map(b => ({ id: b.id, option: Number(b.option_index), amount: Math.max(0, Math.floor(Number(b.bet_amount) || 0)) }));
    const totalWagered = list.reduce((s, b) => s + b.amount, 0);
    const outcomes = new Map();

    if (winnerIndex === null || winnerIndex === undefined) {
        for (const b of list) outcomes.set(b.id, { status: 'refunded', payout: b.amount });
        return { outcomes, totalWagered, totalPaid: totalWagered, houseProfit: 0, refunded: true };
    }

    const winners = list.filter(b => b.option === winnerIndex);
    const winningStake = winners.reduce((s, b) => s + b.amount, 0);

    if (!winners.length || winningStake <= 0) {
        for (const b of list) outcomes.set(b.id, { status: 'lost', payout: 0 });
        return { outcomes, totalWagered, totalPaid: 0, houseProfit: totalWagered, refunded: false };
    }

    const pool = totalWagered - Math.floor(totalWagered * rake);
    let totalPaid = 0;
    for (const b of list) {
        if (b.option === winnerIndex) {
            const payout = Math.floor(pool * (b.amount / winningStake));
            outcomes.set(b.id, { status: 'won', payout });
            totalPaid += payout;
        } else {
            outcomes.set(b.id, { status: 'lost', payout: 0 });
        }
    }
    return { outcomes, totalWagered, totalPaid, houseProfit: totalWagered - totalPaid, refunded: false };
}

/** Validate a bet request. Returns an error string or null. */
export function betError({ optionIndex, amount, optionCount, minBet, maxBet }) {
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= optionCount) {
        return `Pick an option number between 1 and ${optionCount}.`;
    }
    if (!Number.isInteger(amount) || amount <= 0) return 'Your bet must be a whole number above 0.';
    if (amount < minBet || amount > maxBet) return `Bets on this poll must be between ${minBet.toLocaleString()} and ${maxBet.toLocaleString()}.`;
    return null;
}

export default { HOUSE_RAKE, pickWinner, settleBets, betError };
