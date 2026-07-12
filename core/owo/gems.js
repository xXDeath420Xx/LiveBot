/*
 * OwO gem catalog — CC-BY-NC-SA-4.0 derivative. See /LICENSE-OWO-NOTICE.md.
 *
 * Values (amount / length / chance / id) are upstream's, from src/data/gems.json, so the game
 * plays with the same numbers people already know. The EMOJI are ours: upstream's gem emoji live
 * on OwO's own emoji servers and a bot may only use custom emoji from a guild it is in, so we
 * substitute unicode.
 *
 *   amount  Hunting: extra animals per hunt.  Lucky: luck tier.  (Others: unused.)
 *   length  How many uses the gem has once activated — the `[left/length]` counter.
 *   chance  Weight for rolling this tier out of a lootbox (sums to 1 within a type).
 */

/** Gem types that can come out of a lootbox — Special and Patreon cannot. */
export const LOOTABLE_TYPES = Object.freeze(['Hunting', 'Empowering', 'Lucky']);

/** The three slots shown in the hunt's "empowered by" line, in display order. */
export const HUNT_SLOTS = Object.freeze(['Hunting', 'Empowering', 'Lucky']);

export const GEMS = Object.freeze({
  cgem1: { gname: 'cgem1', tier: 'Common', type: 'Hunting', id: 51, amount: 1, length: 25, chance: 0.22, emoji: '⚪🔮' },
  ugem1: { gname: 'ugem1', tier: 'Uncommon', type: 'Hunting', id: 52, amount: 3, length: 25, chance: 0.22, emoji: '🟢🔮' },
  rgem1: { gname: 'rgem1', tier: 'Rare', type: 'Hunting', id: 53, amount: 4, length: 50, chance: 0.2, emoji: '🔵🔮' },
  egem1: { gname: 'egem1', tier: 'Epic', type: 'Hunting', id: 54, amount: 5, length: 75, chance: 0.2, emoji: '🟣🔮' },
  mgem1: { gname: 'mgem1', tier: 'Mythical', type: 'Hunting', id: 55, amount: 6, length: 75, chance: 0.1, emoji: '🟠🔮' },
  lgem1: { gname: 'lgem1', tier: 'Legendary', type: 'Hunting', id: 56, amount: 7, length: 100, chance: 0.05, emoji: '🔴🔮' },
  fgem1: { gname: 'fgem1', tier: 'Fabled', type: 'Hunting', id: 57, amount: 9, length: 100, chance: 0.01, emoji: '🌈🔮' },
  cgem2: { gname: 'cgem2', tier: 'Common', type: 'Patreon', id: 58, amount: null, length: 25, chance: 0.22, emoji: '⚪🏵️' },
  ugem2: { gname: 'ugem2', tier: 'Uncommon', type: 'Patreon', id: 59, amount: null, length: 50, chance: 0.22, emoji: '🟢🏵️' },
  rgem2: { gname: 'rgem2', tier: 'Rare', type: 'Patreon', id: 60, amount: null, length: 75, chance: 0.2, emoji: '🔵🏵️' },
  egem2: { gname: 'egem2', tier: 'Epic', type: 'Patreon', id: 61, amount: null, length: 100, chance: 0.2, emoji: '🟣🏵️' },
  mgem2: { gname: 'mgem2', tier: 'Mythical', type: 'Patreon', id: 62, amount: null, length: 200, chance: 0.1, emoji: '🟠🏵️' },
  lgem2: { gname: 'lgem2', tier: 'Legendary', type: 'Patreon', id: 63, amount: null, length: 300, chance: 0.05, emoji: '🔴🏵️' },
  fgem2: { gname: 'fgem2', tier: 'Fabled', type: 'Patreon', id: 64, amount: null, length: 500, chance: 0.01, emoji: '🌈🏵️' },
  cgem3: { gname: 'cgem3', tier: 'Common', type: 'Empowering', id: 65, amount: null, length: 50, chance: 0.22, emoji: '⚪💠' },
  ugem3: { gname: 'ugem3', tier: 'Uncommon', type: 'Empowering', id: 66, amount: null, length: 100, chance: 0.22, emoji: '🟢💠' },
  rgem3: { gname: 'rgem3', tier: 'Rare', type: 'Empowering', id: 67, amount: null, length: 250, chance: 0.2, emoji: '🔵💠' },
  egem3: { gname: 'egem3', tier: 'Epic', type: 'Empowering', id: 68, amount: null, length: 450, chance: 0.2, emoji: '🟣💠' },
  mgem3: { gname: 'mgem3', tier: 'Mythical', type: 'Empowering', id: 69, amount: null, length: 525, chance: 0.1, emoji: '🟠💠' },
  lgem3: { gname: 'lgem3', tier: 'Legendary', type: 'Empowering', id: 70, amount: null, length: 800, chance: 0.05, emoji: '🔴💠' },
  fgem3: { gname: 'fgem3', tier: 'Fabled', type: 'Empowering', id: 71, amount: null, length: 1000, chance: 0.01, emoji: '🌈💠' },
  cgem4: { gname: 'cgem4', tier: 'Common', type: 'Lucky', id: 72, amount: 1, length: 50, chance: 0.22, emoji: '⚪🍀' },
  ugem4: { gname: 'ugem4', tier: 'Uncommon', type: 'Lucky', id: 73, amount: 2, length: 100, chance: 0.22, emoji: '🟢🍀' },
  rgem4: { gname: 'rgem4', tier: 'Rare', type: 'Lucky', id: 74, amount: 3, length: 250, chance: 0.2, emoji: '🔵🍀' },
  egem4: { gname: 'egem4', tier: 'Epic', type: 'Lucky', id: 75, amount: 4, length: 450, chance: 0.2, emoji: '🟣🍀' },
  mgem4: { gname: 'mgem4', tier: 'Mythical', type: 'Lucky', id: 76, amount: 5, length: 525, chance: 0.1, emoji: '🟠🍀' },
  lgem4: { gname: 'lgem4', tier: 'Legendary', type: 'Lucky', id: 77, amount: 6, length: 800, chance: 0.05, emoji: '🔴🍀' },
  fgem4: { gname: 'fgem4', tier: 'Fabled', type: 'Lucky', id: 78, amount: 7, length: 1000, chance: 0.01, emoji: '🌈🍀' },
  cgem5: { gname: 'cgem5', tier: 'Common', type: 'Special', id: 79, amount: null, length: 50, chance: 0.22, emoji: '⚪🌟' },
  ugem5: { gname: 'ugem5', tier: 'Uncommon', type: 'Special', id: 80, amount: null, length: 100, chance: 0.22, emoji: '🟢🌟' },
  rgem5: { gname: 'rgem5', tier: 'Rare', type: 'Special', id: 81, amount: null, length: 250, chance: 0.2, emoji: '🔵🌟' },
  egem5: { gname: 'egem5', tier: 'Epic', type: 'Special', id: 82, amount: null, length: 450, chance: 0.2, emoji: '🟣🌟' },
  mgem5: { gname: 'mgem5', tier: 'Mythical', type: 'Special', id: 83, amount: null, length: 525, chance: 0.1, emoji: '🟠🌟' },
  lgem5: { gname: 'lgem5', tier: 'Legendary', type: 'Special', id: 84, amount: null, length: 800, chance: 0.05, emoji: '🔴🌟' },
  fgem5: { gname: 'fgem5', tier: 'Fabled', type: 'Special', id: 85, amount: null, length: 1000, chance: 0.01, emoji: '🌈🌟' },
});

/** "Uncommon Empowering Gem" — the exact name upstream prints. */
export const gemName = (gem) => `${gem.tier} ${gem.type} Gem`;

/** English: "an Uncommon…", "an Epic…", but "a Rare…". */
export const article = (gem) => (/^[EUAIO]/.test(gemName(gem)) ? 'an' : 'a');

export const byId = (id) => Object.values(GEMS).find(g => g.id === Number(id)) ?? null;
export const byName = (gname) => GEMS[gname] ?? null;

/** Roll a lootbox gem: pick a lootable type uniformly, then a tier by its `chance` weight. */
export function rollGem() {
  const type = LOOTABLE_TYPES[Math.floor(Math.random() * LOOTABLE_TYPES.length)];
  const tiers = Object.values(GEMS).filter(g => g.type === type);
  let roll = Math.random();
  for (const gem of tiers) {
    roll -= gem.chance;
    if (roll < 0) return gem;
  }
  return tiers[0];
}

const SUP = ['\u2070', '\u00b9', '\u00b2', '\u00b3', '\u2074', '\u2075', '\u2076', '\u2077', '\u2078', '\u2079'];
/** 12 -> "¹²" — upstream renders lootbox haul counts as superscript. */
export const superscript = (n) => String(n).split('').map(d => SUP[Number(d)] ?? d).join('');
