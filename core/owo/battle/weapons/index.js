/*
 * CC-BY-NC-SA-4.0 derivative. Explicit registry replacing upstream's
 * `require-dir('./weapons')` pattern. Indexes all 22 weapons by id (from
 * each weapon's init()) and by class name. Import this wherever upstream
 * iterated `weapons`.
 */

import AbsorbWand from './AbsorbWand.js';
import ArcaneScepter from './ArcaneScepter.js';
import Bow from './Bow.js';
import CelebrationRune from './CelebrationRune.js';
import CullingScythe from './CullingScythe.js';
import EnergyStaff from './EnergyStaff.js';
import FlameStaff from './FlameStaff.js';
import FoulFish from './FoulFish.js';
import GlacialAxe from './GlacialAxe.js';
import Greatsword from './Greatsword.js';
import HealStaff from './HealStaff.js';
import LeechScythe from './LeechScythe.js';
import LuckRune from './LuckRune.js';
import Orb from './Orb.js';
import PoisonDagger from './PoisonDagger.js';
import PurityStaff from './PurityStaff.js';
import ResurrectionStaff from './ResurrectionStaff.js';
import Rune from './Rune.js';
import Shield from './Shield.js';
import SpiritStaff from './SpiritStaff.js';
import VampiricStaff from './VampiricStaff.js';
import VanguardsBanner from './VanguardsBanner.js';

export const WEAPON_CLASSES = {
    AbsorbWand, ArcaneScepter, Bow, CelebrationRune, CullingScythe,
    EnergyStaff, FlameStaff, FoulFish, GlacialAxe, Greatsword,
    HealStaff, LeechScythe, LuckRune, Orb, PoisonDagger,
    PurityStaff, ResurrectionStaff, Rune, Shield, SpiritStaff,
    VampiricStaff, VanguardsBanner,
};

// Lazy-built id → class map. Populated on first call because each class's
// `id` is only set inside its init() which runs on construction.
let _byId = null;
export function getWeaponById(id) {
    if (!_byId) {
        _byId = {};
        for (const [, Cls] of Object.entries(WEAPON_CLASSES)) {
            try {
                const inst = new Cls(null, null, true); // noCreate = true
                _byId[inst.id] = Cls;
            } catch { /* bubble later */ }
        }
    }
    return _byId[id] || null;
}

export default WEAPON_CLASSES;
