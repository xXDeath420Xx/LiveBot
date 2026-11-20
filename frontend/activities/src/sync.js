// Watch Together's clock maths (pure; tests/activities/watch-sync.test.js). The server sends the playback clock as
// { paused, position, at }: the position in seconds at server time `at` (ms). Viewers estimate the server's clock from
// timed requests and steer their player towards the shared position.

/** Where everyone should be, in seconds. */
export function targetPosition(playback, serverNowMs, runtimeSec = Infinity) {
    if (!playback) return 0;
    const pos = playback.paused ? playback.position : playback.position + (serverNowMs - playback.at) / 1000;
    return Math.max(0, Math.min(runtimeSec || Infinity, pos));
}

/**
 * The server clock offset (server - local, ms) from timed samples [{ serverNow, at, rtt }]: the sample with the
 * shortest round trip wins (its midpoint is the best guess of when the server answered).
 */
export function clockOffset(samples) {
    const good = samples.filter((s) => Number.isFinite(s.serverNow) && Number.isFinite(s.at) && Number.isFinite(s.rtt) && s.rtt >= 0 && s.rtt < 10_000);
    if (!good.length) return 0;
    const best = good.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    return best.serverNow - best.at;
}

export const DRIFT = Object.freeze({ seekAbove: 2.0, nudgeAbove: 0.25, settleBelow: 0.1, nudge: 0.05, pausedSeekAbove: 0.4 });

/**
 * What to do with the player: { seek: seconds | null, rate }. Small drift: play 5 % faster or slower until within
 * settleBelow (no visible jump); large drift (a join, a stall, a seek): jump.
 * `nudging` is whether the player is currently being nudged (hysteresis between nudgeAbove and settleBelow).
 */
export function correction({ current, target, paused, nudging = false }) {
    const d = current - target;
    const ad = Math.abs(d);
    if (paused) return { seek: ad > DRIFT.pausedSeekAbove ? target : null, rate: 1 };
    if (ad > DRIFT.seekAbove) return { seek: target, rate: 1 };
    if (ad > DRIFT.nudgeAbove || (nudging && ad > DRIFT.settleBelow)) return { seek: null, rate: d > 0 ? 1 - DRIFT.nudge : 1 + DRIFT.nudge };
    return { seek: null, rate: 1 };
}
