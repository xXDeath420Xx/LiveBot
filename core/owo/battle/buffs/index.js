/*
 * CC-BY-NC-SA-4.0 derivative. Explicit registry for all 12 combat buffs.
 * AttackUp/AttackUp+/AttackUp++ are three distinct tiers.
 */

import AttackUp from './AttackUp.js';
import AttackUpPlus from './AttackUp+.js';
import AttackUpPlusPlus from './AttackUp++.js';
import Celebration from './Celebration.js';
import DefenseUp from './DefenseUp.js';
import Flame from './Flame.js';
import Freeze from './Freeze.js';
import Leech from './Leech.js';
import Mortality from './Mortality.js';
import Poison from './Poison.js';
import Stinky from './Stinky.js';
import Taunt from './Taunt.js';

export const BUFF_CLASSES = {
    AttackUp,
    'AttackUp+': AttackUpPlus,
    'AttackUp++': AttackUpPlusPlus,
    Celebration, DefenseUp, Flame, Freeze, Leech,
    Mortality, Poison, Stinky, Taunt,
};

let _byId = null;
export function getBuffById(id) {
    if (!_byId) {
        _byId = {};
        for (const [, Cls] of Object.entries(BUFF_CLASSES)) {
            try {
                const inst = new Cls();
                _byId[inst.id] = Cls;
            } catch { /* skip */ }
        }
    }
    return _byId[id] || null;
}

export default BUFF_CLASSES;
