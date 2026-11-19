/*
 * The join gate's age arithmetic, with no database import.
 *
 * Split out for the same reason commission-spam-match.js is: importing core/join-gate.js opens the
 * shared pool, and a test or one-off script that only wants the thresholds then hangs on exit
 * instead of finishing. The arithmetic is also the whole feature — two thresholds with two easy
 * ways to be wrong — so it deserves to be testable on its own.
 */
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/**
 * Which tier an account of this age falls into.
 *
 * @param {number} ageMs  how long ago the Discord account was created
 * @param {{kick_under_hours?: number, apply_under_days?: number}} [cfg]
 * @returns {'pass'|'too_new'|'apply'}
 */
export function tierFor(ageMs, cfg) {
  const kickUnder = (cfg?.kick_under_hours ?? 24) * HOUR;
  const applyUnder = (cfg?.apply_under_days ?? 7) * DAY;
  // A window configured shut (apply <= kick) leaves no age in the application band, so everything
  // young is simply removed. That is the safe direction to fail: never a free pass.
  if (ageMs < kickUnder) return 'too_new';
  if (ageMs < applyUnder) return 'apply';
  return 'pass';
}

/** "3 days", "17 hours", "42 minutes" — the age in the largest unit that is not misleading. */
export function humanAge(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} hours`;
  return `${Math.round(ms / DAY)} days`;
}

export default { tierFor, humanAge, HOUR, DAY };
