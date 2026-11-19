/**
 * Per-game switches on the Kick channel page (/kick/channel/:id, "Chat settings"): Tokes, Daily spark,
 * Smoke sessions and Trivia, saved in tokes_channels.features_enabled as tokes / spark / sessions /
 * trivia. A game is on unless its switch is saved as false, the same rule the page uses to draw the
 * switch (feats[key] !== false). Before this module the switches were saved and never read.
 *
 * Only the commands that play a game are listed; leaderboards (!fireboard, !embers), !strain and the
 * rest keep their own per-command switch on the Commands page.
 */
export const GAME_FEATURE_BY_COMMAND = Object.freeze({
    lit: 'tokes',
    spark: 'spark',
    sesh: 'sessions', hit: 'sessions', pass: 'sessions', doused: 'sessions',
    trivia: 'trivia', answer: 'trivia'
});

/**
 * @param {object|null} feats       the channel's parsed features_enabled
 * @param {string}      commandKey  the built-in command's key (aliases are already resolved to it)
 * @returns {boolean} true when the command belongs to a game the channel switched off
 */
export function isGameSwitchedOff(feats, commandKey) {
    const game = Object.hasOwn(GAME_FEATURE_BY_COMMAND, commandKey) ? GAME_FEATURE_BY_COMMAND[commandKey] : null;
    return !!game && !!feats && typeof feats === 'object' && feats[game] === false;
}
