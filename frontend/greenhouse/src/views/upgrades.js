// Upgrades tab: the one upgrade tree (growing, selling, staff branches) and the Staff system.
import { h } from '../lib/dom.js';
import { money, count } from '../lib/format.js';
import { UI } from '../copy.js';
import { confirmDialog } from '../ui/dialog.js';
import { actionButton, section, segmented, progress } from '../ui/widgets.js';
import { staffCard } from './greenhouse.js';
import { renderSlot, hasSlot } from '../slots.js';
import * as M from '../model.js';

const T = UI.upgrades;

function mem(app) {
    if (!app.mem.upgrades) app.mem.upgrades = { section: 'upgrades' };
    return app.mem.upgrades;
}

function effectText(node, level = 1) {
    const fn = T.effect[node.effect.stat];
    return fn ? fn(node.effect.perLevel * (level || 1)) : '';
}

function upgradeRow(app, node, row) {
    const level = row ? row.level : 0;
    const next = row && row.next;
    const met = row ? row.requirementsMet : true;
    const cash = app.state.account.cash;
    let reason = null;
    if (!next) reason = T.maxed;
    else if (!met) reason = node.requires.map(r => T.needs(M.upgradeName(app, r.code), r.level)).join('. ');
    const total = node.effect.perLevel * level;
    const nowText = level && node.effect.stat !== 'plots' && node.effect.stat !== 'staff_slots' ? T.now(`+${total}%`) : null;
    const reasonId = `up-${node.code}-why`;
    return h('li', { class: 'card' },
        h('div', { class: 'card-main' },
            h('h2', { class: 'card-title' }, node.name, ' ', h('span', { class: 'chip' }, T.levelOf(level, node.maxLevel))),
            h('p', { class: 'small' }, effectText(node)),
            nowText ? h('p', { class: 'muted small' }, nowText) : null,
            progress(level / node.maxLevel, { label: `${node.name}: ${T.levelOf(level, node.maxLevel)}`, cls: 'progress-thin' }),
            reason ? h('p', { class: 'muted small', id: reasonId }, reason) : null),
        next ? h('div', { class: 'card-foot card-foot-end' },
            actionButton(T.buy(money(next.cost)), () => app.act('/upgrades/buy', { code: node.code, level: next.level }, {
                done: (r) => app.toast(T.bought(node.name, r.level))
            }), { small: true, key: `up-${node.code}`, disabled: !met || next.cost > cash, describedBy: reason ? reasonId : null })) : null);
}

function upgradesSection(app) {
    const byBranch = new Map();
    for (const node of app.catalog.upgrades) {
        if (!byBranch.has(node.branch)) byBranch.set(node.branch, []);
        byBranch.get(node.branch).push(node);
    }
    return h('div', { class: 'stack' }, [...byBranch.entries()].map(([branch, nodes]) => [
        section(T.branches[branch] || branch),
        h('ul', { class: 'cards', role: 'list' }, nodes.map(node => upgradeRow(app, node, app.state.upgrades.find(u => u.code === node.code))))
    ]));
}

function staffSection(app) {
    const cash = app.state.account.cash;
    return h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, T.staffIntro),
        staffCard(app, { always: true }),
        h('ul', { class: 'cards', role: 'list' }, app.state.staff.map(s => {
            const type = M.staffType(app, s.code);
            const name = type ? type.name : s.code;
            const makes = s.output === 'cash' ? T.staffMakes.cash(money(s.perHourEach))
                : T.staffMakes[s.output](count(s.perHourEach), M.varietyName(app, s.itemId));
            if (!s.unlocked) {
                return h('li', { class: 'card card-locked' }, h('div', { class: 'card-main' },
                    h('h2', { class: 'card-title' }, name), h('p', { class: 'small' }, makes),
                    h('p', { class: 'muted small' }, T.opensAt(type ? type.unlockLevel : '?'))));
            }
            const full = s.nextHireCost == null;
            return h('li', { class: 'card' },
                h('div', { class: 'card-main' },
                    h('h2', { class: 'card-title' }, name, ' ', h('span', { class: 'chip' }, T.hired(s.count, s.max))),
                    h('p', { class: 'small' }, makes),
                    full ? h('p', { class: 'muted small' }, T.full) : null),
                h('div', { class: 'card-foot' },
                    s.count > 0 ? actionButton(T.fire, async () => {
                        const ok = await confirmDialog({ title: T.fire, text: T.fireConfirm(name), confirmText: T.fire, danger: true });
                        if (ok) await app.act('/staff/fire', { code: s.code, count: s.count - 1 }, { done: () => app.toast(T.firedToast(name)) });
                    }, { cls: 'btn-ghost', small: true, key: `fire-${s.code}` }) : h('span'),
                    full ? null : actionButton(T.hire(money(s.nextHireCost)), () => app.act('/staff/hire', { code: s.code, count: s.count + 1 }, {
                        done: () => app.toast(T.hiredToast(name))
                    }), { small: true, key: `hire-${s.code}`, disabled: s.nextHireCost > cash })));
        })));
}

export function render(app) {
    const m = mem(app);
    const sections = [['upgrades', T.sections.upgrades], ['staff', T.sections.staff]];
    if (hasSlot('upgrades.decor')) sections.push(['decor', UI.decor.section]);
    if (!sections.some(([v]) => v === m.section)) m.section = 'upgrades';
    return h('div', { class: 'view-body' },
        renderSlot('upgrades.top', app),
        segmented(UI.tabHeadings.upgrades, sections, m.section,
            (value) => { m.section = value; app.render({ focus: `seg-${UI.tabHeadings.upgrades}-${value}` }); }),
        m.section === 'staff' ? staffSection(app) : m.section === 'decor' ? renderSlot('upgrades.decor', app) : upgradesSection(app));
}
