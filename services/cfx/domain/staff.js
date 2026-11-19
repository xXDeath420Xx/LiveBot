// Greenhouse Tycoon (cfx v2): what staff earned while the player was away. Pure, closed form, no ticks.
//
// Each staff row (one staff type on one account) has its own clock, last_claim_at_ms. A claim pays
//   units = floor(count * perHour * (100 + ratePct)% * credited / 1 h)
// where credited = min(now - clock, OFFLINE_CAP_MS) (owner decision: at most 12 hours).
//
// The clock then moves forward by exactly the time those whole units took, so claiming often never loses
// part-finished work. If the player was away longer than the cap, everything past the cap is forfeited and
// the clock jumps to now. A clock in the future (clock skew) pays nothing and is left alone.
import { HOUR_MS, OFFLINE_CAP_MS } from '../config/game.js';

function assertInt(name, value, min = 0) {
    if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be an integer >= ${min}`);
}

/**
 * @param {object} p
 * @param {{code:string, output:string, perHour:number, count:number, lastClaimAtMs:number}[]} p.staff
 * @param {number} p.nowMs
 * @param {number} [p.ratePct]  bonus from upgrades, percent
 * @param {number} [p.capMs]    offline cap; defaults to OFFLINE_CAP_MS and may never exceed it
 * @returns {{ rows: {code, output, units, elapsedMs, creditedMs, forfeitedMs, newLastClaimAtMs}[],
 *             totals: Record<string, number> }}
 */
export function offlineClaim({ staff, nowMs, ratePct = 0, capMs = OFFLINE_CAP_MS }) {
    assertInt('nowMs', nowMs);
    assertInt('ratePct', ratePct);
    assertInt('capMs', capMs);
    const cap = Math.min(capMs, OFFLINE_CAP_MS);
    const rows = [];
    const totals = {};
    for (const s of staff) {
        assertInt(`${s.code}.count`, s.count);
        assertInt(`${s.code}.perHour`, s.perHour);
        assertInt(`${s.code}.lastClaimAtMs`, s.lastClaimAtMs);
        const elapsed = nowMs - s.lastClaimAtMs;
        const ratePerHour100 = s.count * s.perHour * (100 + ratePct); // hundredths of a unit per hour
        if (elapsed <= 0 || ratePerHour100 === 0) {
            // Nothing earned; a zero-count row keeps no backlog, so its clock follows now.
            const clock = elapsed <= 0 ? s.lastClaimAtMs : nowMs;
            rows.push({ code: s.code, output: s.output, units: 0, elapsedMs: Math.max(0, elapsed), creditedMs: 0, forfeitedMs: 0, newLastClaimAtMs: clock });
            continue;
        }
        const credited = Math.min(elapsed, cap);
        const product = ratePerHour100 * credited;
        if (!Number.isSafeInteger(product)) throw new RangeError('staff output overflow');
        const units = Math.floor(product / (HOUR_MS * 100));
        let newClock;
        if (elapsed > cap) {
            newClock = nowMs; // forfeit everything past the cap, including the part-finished unit
        } else {
            // Time the whole units took; ceil keeps it <= credited because units*H*100/rate <= credited.
            const consumed = units === 0 ? 0 : Math.ceil((units * HOUR_MS * 100) / ratePerHour100);
            newClock = s.lastClaimAtMs + consumed;
        }
        rows.push({
            code: s.code,
            output: s.output,
            units,
            elapsedMs: elapsed,
            creditedMs: credited,
            forfeitedMs: elapsed - credited,
            newLastClaimAtMs: newClock
        });
        totals[s.output] = (totals[s.output] || 0) + units;
    }
    return { rows, totals };
}
