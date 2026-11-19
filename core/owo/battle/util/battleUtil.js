/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/util/battleUtil.js
 * See /LICENSE-OWO-NOTICE.md.
 *
 * Only upstream's action markers are used: the weapon classes (Shield, VanguardsBanner) compare the
 * action they're given against `weapon`. Battles themselves run in core/owo/battle-engine.js; upstream's
 * turn loop, XP maths and pet-team/settings queries lived with the battle files nothing loaded, removed
 * 2026-10-05.
 */
const exports = {};

exports.attack = '👊🏼';
exports.weapon = '🗡';

export default exports;
