// Greenhouse Tycoon (cfx v2): plant growth, computed from timestamps when read. Pure, no I/O.
// All times are integer milliseconds since the epoch (columns *_at_ms in the schema); there is no
// 10-second tick that advances plants.
import { GROWTH } from '../config/game.js';

function assertInt(name, value, min = 0) {
    if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be an integer >= ${min}`);
}

/** When a plant planted at plantedAtMs is ready. speedPct (from upgrades) shortens the time, capped. */
export function readyAt({ plantedAtMs, growMs, speedPct = 0 }) {
    assertInt('plantedAtMs', plantedAtMs);
    assertInt('growMs', growMs, 1);
    assertInt('speedPct', speedPct);
    const pct = Math.min(speedPct, GROWTH.MAX_SPEED_PCT);
    const effective = Math.max(GROWTH.MIN_GROW_MS, Math.round((growMs * (100 - pct)) / 100));
    return plantedAtMs + effective;
}

/**
 * State of one plot at nowMs.
 *   { status: 'empty' }
 *   { status: 'growing', progress 0..<1, remainingMs > 0, readyAtMs }
 *   { status: 'ready', progress: 1, remainingMs: 0, readyAtMs }
 */
export function plotState(plot, nowMs) {
    assertInt('nowMs', nowMs);
    if (!plot || plot.varietyId == null) return { status: 'empty' };
    const planted = plot.plantedAtMs;
    const ready = plot.readyAtMs;
    assertInt('plantedAtMs', planted);
    assertInt('readyAtMs', ready);
    if (ready < planted) throw new RangeError('readyAtMs is before plantedAtMs');
    if (nowMs >= ready) return { status: 'ready', progress: 1, remainingMs: 0, readyAtMs: ready };
    const total = ready - planted;
    const elapsed = Math.max(0, nowMs - planted);
    return { status: 'growing', progress: total === 0 ? 1 : elapsed / total, remainingMs: ready - nowMs, readyAtMs: ready };
}

/** Units harvested: baseYield raised by yieldPct; the fractional part is paid with that probability. */
export function harvestYield({ baseYield, yieldPct = 0, rng }) {
    assertInt('baseYield', baseYield, 1);
    assertInt('yieldPct', yieldPct);
    const scaled = baseYield * (100 + yieldPct); // hundredths of a unit
    const whole = Math.floor(scaled / 100);
    const fraction = (scaled % 100) / 100;
    return whole + (fraction > 0 && rng.chance(fraction) ? 1 : 0);
}

// Quality band thresholds on a 0..999 roll: >= 970 show grade, >= 850 premium, >= 550 fine.
const QUALITY_THRESHOLDS = [970, 850, 550];

/** Quality band 0..3 from a roll in [0, 999]; qualityPct raises the roll (each point = +3, max +300). */
export function qualityBand({ roll, qualityPct = 0 }) {
    assertInt('roll', roll);
    if (roll > 999) throw new RangeError('roll must be 0..999');
    assertInt('qualityPct', qualityPct);
    const boosted = Math.min(999, roll + Math.min(300, qualityPct * 3));
    if (boosted >= QUALITY_THRESHOLDS[0]) return 3;
    if (boosted >= QUALITY_THRESHOLDS[1]) return 2;
    if (boosted >= QUALITY_THRESHOLDS[2]) return 1;
    return 0;
}
