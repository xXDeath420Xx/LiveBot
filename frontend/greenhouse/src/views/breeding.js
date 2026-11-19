// Breed tab: cross two different base plants into a hybrid ("Parent A × Parent B"), collect its seeds, and
// see the hybrids found so far. Rules (level, fee, time, seeds out) come from the catalogue.
import { h } from '../lib/dom.js';
import { money, duration } from '../lib/format.js';
import { UI } from '../copy.js';
import { plantSvg, artFor } from '../art/plant.js';
import { actionButton, section, emptyState, progress, countdown } from '../ui/widgets.js';
import { renderSlot } from '../slots.js';
import * as M from '../model.js';

const T = UI.breed;

function mem(app) {
    if (!app.mem.breed) app.mem.breed = { a: null, b: null };
    return app.mem.breed;
}

/** Art for a cross that may not exist yet: a hybrid-shaped lookup with the parents. */
function crossArt(app, a, b) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return artFor({ id: -1, hybrid: true, parents: [lo, hi] }, (x) => M.variety(app, x));
}

function crossName(app, a, b) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return `${M.varietyName(app, lo)} × ${M.varietyName(app, hi)}`;
}

function activeCross(app, cross) {
    const now = app.now();
    const ready = now >= cross.readyAtMs;
    const stage = Math.min(1, (now - cross.startedAtMs) / Math.max(1, cross.readyAtMs - cross.startedAtMs));
    return h('div', { class: 'card' },
        h('div', { class: 'card-row' },
            plantSvg(crossArt(app, cross.parentA, cross.parentB), { stage: ready ? 1 : Math.max(0.15, stage), className: 'plant-art plant-art-md' }),
            h('div', { class: 'card-main' },
                h('p', { class: 'eyebrow' }, T.active),
                h('h2', { class: 'card-title' }, crossName(app, cross.parentA, cross.parentB)),
                ready ? h('p', { class: 'accent' }, UI.grow.ready) : h('p', null, countdown(cross.readyAtMs, now, { format: T.readyIn, done: UI.grow.ready })),
                ready ? null : progress(stage, { label: T.readyIn('') }))),
        h('div', { class: 'card-foot' },
            actionButton(T.claim, () => app.act('/breeding/claim', { breedingId: cross.id }, {
                done: (r) => app.toast(T.claimed(r.variety ? r.variety.name : M.varietyName(app, r.varietyId), r.seeds || app.catalog.rules.breeding.seedsOut, r.newDiscovery))
            }), { disabled: !ready, key: 'claim-cross' })));
}

function parentSelect(app, id, label, value, other, onPick) {
    const options = app.catalog.varieties.filter(v => M.discovered(app, v.id) && M.seedCount(app, v.id) > 0);
    return h('div', { class: 'field' },
        h('label', { for: id, class: 'field-label' }, label),
        h('select', { id, class: 'select', dataset: { key: id }, on: { change: (e) => onPick(e.target.value ? Number(e.target.value) : null) } },
            h('option', { value: '', selected: value == null }, T.choose),
            options.map(v => h('option', { value: String(v.id), selected: value === v.id, disabled: v.id === other }, T.seedsLeft(v.name, M.seedCount(app, v.id))))));
}

function newCross(app) {
    const m = mem(app);
    const usable = app.catalog.varieties.filter(v => M.discovered(app, v.id) && M.seedCount(app, v.id) > 0);
    if (m.a != null && !usable.some(v => v.id === m.a)) m.a = null;
    if (m.b != null && !usable.some(v => v.id === m.b)) m.b = null;
    if (usable.length < 2) {
        return h('div', { class: 'card' }, emptyState(T.noParents,
            h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => app.go('market', { section: 'shop' }) } }, UI.grow.toShop)));
    }
    const pick = (field) => (value) => { m[field] = value; app.render(); };
    let preview = null;
    if (m.a != null && m.b != null && m.a !== m.b) {
        const plan = M.breedingPlan(app, m.a, m.b);
        const known = M.hybridOf(app, m.a, m.b);
        const enoughCash = app.state.account.cash >= plan.feeCash;
        const reason = !enoughCash ? T.needCash : null;
        preview = h('div', { class: 'card' },
            h('div', { class: 'card-row' },
                plantSvg(crossArt(app, m.a, m.b), { className: 'plant-art plant-art-md' }),
                h('div', { class: 'card-main' },
                    h('p', { class: 'eyebrow' }, T.preview),
                    h('h2', { class: 'card-title' }, crossName(app, m.a, m.b)),
                    h('p', { class: known ? 'muted small' : 'accent small' }, known ? T.known : T.isNew),
                    h('p', { class: 'small' }, `${T.fee(money(plan.feeCash))}, ${T.takes(duration(plan.durationMs))}, ${T.gives(plan.seedsOut)}.`))),
            reason ? h('p', { class: 'muted small', id: 'cross-reason' }, reason) : null,
            h('div', { class: 'card-foot' },
                actionButton(T.start(money(plan.feeCash)), () => app.act('/breeding/start', { parentA: m.a, parentB: m.b }, {
                    done: () => { app.toast(T.started); m.a = null; m.b = null; }
                }), { disabled: !!reason, key: 'start-cross', describedBy: reason ? 'cross-reason' : null })));
    } else if (m.a != null && m.a === m.b) {
        preview = h('p', { class: 'muted small' }, T.sameParent);
    }
    return h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, T.intro),
        h('div', { class: 'field-pair' },
            parentSelect(app, 'parent-a', T.parentA, m.a, m.b, pick('a')),
            parentSelect(app, 'parent-b', T.parentB, m.b, m.a, pick('b'))),
        preview);
}

function collection(app) {
    const hybrids = app.state.hybrids || [];
    const n = app.catalog.varieties.length;
    const max = (n * (n - 1)) / 2;
    return h('div', { class: 'stack' },
        section(T.collection, { count: T.collectionCount(hybrids.length, max) }),
        hybrids.length
            ? h('ul', { class: 'gallery', role: 'list' }, hybrids.map(v => h('li', { class: 'gallery-item' },
                plantSvg(M.art(app, v.id), { className: 'plant-art plant-art-sm' }),
                h('span', { class: 'gallery-name' }, v.name))))
            : emptyState(T.noHybrids));
}

export function render(app) {
    const rules = app.catalog.rules.breeding;
    const level = app.state.account.level;
    if (level < rules.minLevel) {
        const a = app.state.account;
        const span = Math.max(1, (a.nextLevelXp || a.xp) - a.levelStartXp);
        return h('div', { class: 'view-body' },
            h('div', { class: 'card' },
                h('h2', { class: 'card-title' }, T.lockedTitle),
                h('p', null, T.locked(rules.minLevel, level)),
                progress((a.xp - a.levelStartXp) / span, { label: UI.xpLine(a.xp - a.levelStartXp, span) })),
            collection(app));
    }
    const cross = (app.state.breeding || [])[0];
    return h('div', { class: 'view-body' },
        cross ? activeCross(app, cross) : null,
        section(T.newCross),
        cross ? h('p', { class: 'muted small' }, T.busy) : newCross(app),
        collection(app),
        renderSlot('breed.bottom', app));
}
