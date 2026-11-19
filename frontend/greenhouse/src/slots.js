// Places in the tabs that other modules fill. A slot renders nothing until something registers for it (and
// nothing when every renderer returns null), so the tabs need no edits for new cards:
//   registerSlot('profile.season', (app) => seasonCard(app));
// Slots: grow.top, grow.benches, grow.bottom, market.top, breed.bottom, upgrades.top, upgrades.decor,
// profile.season, profile.achievements. Phase 4 fills them in phase4.js.
import { h } from './lib/dom.js';

const slots = new Map();

export function registerSlot(name, render) {
    if (!slots.has(name)) slots.set(name, []);
    slots.get(name).push(render);
}

export function hasSlot(name) {
    return !!(slots.get(name) || []).length;
}

export function renderSlot(name, app) {
    const list = slots.get(name);
    if (!list || !list.length) return null;
    const parts = list.map(fn => fn(app)).filter(Boolean);
    if (!parts.length) return null;
    return h('div', { class: 'slot', dataset: { slot: name } }, parts);
}
