/*
 * CC-BY-NC-SA-4.0 derivative. Explicit registry for all 21 weapon passives.
 * Replaces upstream's require-dir usage in WeaponInterface.js.
 */

import Absolve from './Absolve.js';
import Critical from './Critical.js';
import Discharge from './Discharge.js';
import Energize from './Energize.js';
import Enrage from './Enrage.js';
import HealthPoint from './HealthPoint.js';
import Kamikaze from './Kamikaze.js';
import Knowledge from './Knowledge.js';
import Lifesteal from './Lifesteal.js';
import Magic from './Magic.js';
import MagicResist from './MagicResist.js';
import Manatap from './Manatap.js';
import PhysicalResist from './PhysicalResist.js';
import Regeneration from './Regeneration.js';
import Sacrifice from './Sacrifice.js';
import Safeguard from './Safeguard.js';
import Snail from './Snail.js';
import Sprout from './Sprout.js';
import Strength from './Strength.js';
import Thorns from './Thorns.js';
import WeaponPoint from './WeaponPoint.js';

export const PASSIVE_CLASSES = {
    Absolve, Critical, Discharge, Energize, Enrage,
    HealthPoint, Kamikaze, Knowledge, Lifesteal, Magic,
    MagicResist, Manatap, PhysicalResist, Regeneration,
    Sacrifice, Safeguard, Snail, Sprout, Strength,
    Thorns, WeaponPoint,
};

// Name-keyed registry used by WeaponInterface's passive resolution code.
// Upstream exposed this as a top-level `passives` object via require-dir.
let _byName = null;
export function getPassives() {
    if (_byName) return _byName;
    _byName = {};
    for (const [name, Cls] of Object.entries(PASSIVE_CLASSES)) {
        _byName[name] = Cls;
    }
    return _byName;
}

let _byId = null;
export function getPassiveById(id) {
    if (!_byId) {
        _byId = {};
        for (const [, Cls] of Object.entries(PASSIVE_CLASSES)) {
            try {
                const inst = new Cls();
                _byId[inst.id] = Cls;
            } catch { /* skip */ }
        }
    }
    return _byId[id] || null;
}

export default PASSIVE_CLASSES;
