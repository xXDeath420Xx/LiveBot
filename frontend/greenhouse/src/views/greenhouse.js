// Grow tab: the benches (plots), the daily reward and what the staff earned.
import { h } from '../lib/dom.js';
import { money, duration, count } from '../lib/format.js';
import { UI } from '../copy.js';
import { plantSvg } from '../art/plant.js';
import { icon } from '../art/icons.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { actionButton, section, emptyState, progress, countdown } from '../ui/widgets.js';
import { renderSlot } from '../slots.js';
import * as M from '../model.js';

const T = UI.grow;

function rewardText(app, reward) {
    if (!reward) return '';
    const seeds = (reward.items || []).map(i => `${i.delta ?? i.quantity} ${M.varietyName(app, i.itemId)} seeds`).join(', ');
    return T.dailyBody(app.state.daily.streak, money(reward.cash), seeds);
}

function dailyCard(app) {
    const d = app.state.daily;
    if (d.claimedToday) return null;
    return h('div', { class: 'card card-row' },
        h('div', { class: 'card-main' },
            h('h2', { class: 'card-title' }, T.dailyTitle),
            h('p', { class: 'muted' }, rewardText(app, d.nextReward))),
        actionButton(T.dailyAction, () => app.act('/daily', {}, {
            done: (r) => app.toast(`${T.dailyTitle}: ${money(r.cash)}.`)
        }), { key: 'daily' }));
}

/** What staff earned so far, in words ("12 Sunmoss, 4 Ember Coleus seeds, $40"). */
export function staffPendingText(app) {
    const parts = [];
    for (const s of app.state.staff) {
        if (!s.pending || !s.pending.units) continue;
        if (s.output === 'cash') parts.push(money(s.pending.units));
        else if (s.output === 'seed') parts.push(`${count(s.pending.units)} ${M.varietyName(app, s.itemId)} seeds`);
        else parts.push(`${count(s.pending.units)} ${M.varietyName(app, s.itemId)}`);
    }
    return parts.join(', ');
}

/** When the oldest staff clock reaches the 12-hour limit. */
export function staffFullAt(app) {
    const clocks = app.state.staff.filter(s => s.count > 0 && s.lastClaimAtMs != null).map(s => s.lastClaimAtMs);
    return clocks.length ? Math.min(...clocks) + app.state.offlineCapMs : null;
}

export function staffCard(app, { always = false } = {}) {
    const hired = app.state.staff.some(s => s.count > 0);
    if (!hired) return null;
    const text = staffPendingText(app);
    if (!text && !always) return null;
    const fullAt = staffFullAt(app);
    const now = app.now();
    return h('div', { class: 'card card-row' },
        h('div', { class: 'card-main' },
            h('h2', { class: 'card-title' }, T.staffTitle),
            h('p', null, text || UI.upgrades.nothingPending),
            fullAt != null ? h('p', { class: 'muted small' }, fullAt > now ? countdown(fullAt, now, { format: T.staffCap, done: T.staffFull }) : T.staffFull) : null),
        actionButton(T.staffAction, () => app.act('/staff/claim', {}, {
            done: (r) => app.toast(UI.upgrades.collected(staffClaimText(app, r)))
        }), { key: 'staff-claim', disabled: !text }));
}

function staffClaimText(app, r) {
    const parts = [];
    if (r.cash) parts.push(money(r.cash));
    for (const i of r.items || []) parts.push(`${count(i.delta)} ${M.varietyName(app, i.itemId)}${i.kind === 'seed' ? ' seeds' : ''}`);
    return parts.join(', ') || money(0);
}

function harvestText(app, harvested) {
    return T.harvested(harvested.map(x => `${x.units} ${M.varietyName(app, x.varietyId)} (${M.qualityName(app, x.quality)})`).join(', '));
}

function plotStatus(app, plot, now) {
    if (plot.status === 'empty') return { text: T.empty, short: T.emptyHint, kind: 'empty' };
    if (M.isReady(plot, now)) return { text: T.ready, short: T.readyShort, kind: 'ready' };
    return { text: T.timeLeft(duration(plot.readyAtMs - now)), kind: 'growing' };
}

function plotTile(app, plot, now) {
    const st = plotStatus(app, plot, now);
    const name = plot.status === 'empty' ? T.empty : M.varietyName(app, plot.varietyId);
    const waterable = st.kind === 'growing' && !plot.watered && plot.waterableAtMs != null && now >= plot.waterableAtMs;
    const onClick = () => {
        if (st.kind === 'empty') return plantDialog(app, plot.slot);
        if (M.isReady(plot, app.now())) {
            return app.act('/plots/harvest', { slot: plot.slot, plantSeq: plot.plantSeq }, { done: (r) => app.toast(harvestText(app, r.harvested)) });
        }
        return plotDialog(app, plot.slot);
    };
    return h('button', {
        type: 'button', class: ['plot', `plot-${st.kind}`], dataset: { key: `plot-${plot.slot}` },
        on: { click: async (e) => {
            const b = e.currentTarget;
            if (b.getAttribute('aria-busy') === 'true') return;
            b.setAttribute('aria-busy', 'true');
            try { await onClick(); } finally { if (document.contains(b)) b.removeAttribute('aria-busy'); }
        } }
    },
    plantSvg(plot.status === 'empty' ? null : M.art(app, plot.varietyId), { stage: M.plotStage(plot, now) }),
    // The button's name is its visible text, with the bench number for screen readers.
    h('span', { class: 'plot-name' }, h('span', { class: 'sr-only' }, T.plotLabel(plot.slot)), name),
    h('span', { class: 'plot-status' },
        st.kind === 'growing' ? countdown(plot.readyAtMs, now, { format: T.timeLeft, done: T.ready }) : st.short),
    st.kind === 'growing' && (plot.watered || waterable) ? h('span', { class: ['chip', waterable && 'chip-accent'] }, plot.watered ? T.watered : T.waterNow) : null);
}

function benchTile(app) {
    const shop = app.state.upgrades.find(u => u.code === 'extra_bench');
    if (!shop || !shop.next) return null;
    const cost = shop.next.cost;
    const afford = app.state.account.cash >= cost;
    return h('button', {
        type: 'button', class: 'plot plot-add', dataset: { key: 'plot-add' }, 'aria-disabled': afford ? null : 'true',
        on: { click: async () => {
            if (!afford) { app.toast(T.benchNeedCash(money(cost))); return; }
            const ok = await confirmDialog({ title: T.addBench, text: T.addBenchConfirm(money(cost), app.state.plotsOwned + 1), confirmText: UI.upgrades.buy(money(cost)) });
            if (ok) await app.act('/shop/plot', { level: shop.next.level }, { done: () => app.toast(UI.upgrades.bought(M.upgradeName(app, 'extra_bench'), shop.next.level)) });
        } }
    }, icon('plus', { size: 22 }), h('span', { class: 'plot-name' }, T.addBench), h('span', { class: 'plot-status' }, T.addBenchCost(money(cost))));
}

export function plantDialog(app, slot) {
    openDialog({
        title: T.plantTitle(slot),
        render: (close) => {
            const plot = app.state.plots.find(p => p.slot === slot);
            if (!plot || plot.status !== 'empty') return null;
            const seeds = app.state.inventory.seeds.filter(x => x.quantity > 0);
            if (!seeds.length) {
                return emptyState(T.noSeeds, h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => { close(); app.go('market', { section: 'shop' }); } } }, T.toShop));
            }
            const speed = (app.state.effects && app.state.effects.speed_pct) || 0;
            return h('ul', { class: 'pick-list', role: 'list' }, seeds.map(seed => {
                const v = M.variety(app, seed.varietyId);
                const grow = v ? Math.max(app.catalog.rules.minGrowMs, Math.round((v.growMs * 100) / (100 + speed))) : 0;
                return h('li', null, actionButton([
                    plantSvg(M.art(app, seed.varietyId), { className: 'plant-art plant-art-sm' }),
                    h('span', { class: 'pick-main' }, h('span', { class: 'pick-name' }, M.varietyName(app, seed.varietyId)),
                        h('span', { class: 'pick-sub' }, `${T.owned(seed.quantity)}, ${T.growsIn(duration(grow))}`))
                ], () => app.act('/plots/plant', { slot, varietyId: seed.varietyId }, {
                    done: () => { close(); app.toast(T.planted(M.varietyName(app, seed.varietyId))); }
                }), { cls: 'pick', key: `plant-${seed.varietyId}` }));
            }));
        }
    });
}

export function plotDialog(app, slot) {
    const first = app.state.plots.find(p => p.slot === slot);
    if (!first || first.status === 'empty') return;
    const seq = first.plantSeq;
    openDialog({
        title: M.varietyName(app, first.varietyId),
        render: (close) => {
            const plot = app.state.plots.find(p => p.slot === slot);
            if (!plot || plot.status === 'empty' || plot.plantSeq !== seq) return null;
            const now = app.now();
            const ready = M.isReady(plot, now);
            const stage = M.plotStage(plot, now);
            const waterOpen = !plot.watered && plot.waterableAtMs != null && now >= plot.waterableAtMs;
            const boosts = app.catalog.boosts.filter(b => app.state.account.level >= b.unlockLevel);
            const body = h('div', { class: 'stack' },
                h('div', { class: 'plot-detail' },
                    plantSvg(M.art(app, plot.varietyId), { stage, className: 'plant-art plant-art-lg' }),
                    h('div', { class: 'stack-sm' },
                        h('p', { class: 'strong' }, ready ? T.ready : countdown(plot.readyAtMs, now, { format: T.timeLeft, done: T.ready })),
                        progress(stage, { label: T.timeLeft('') }),
                        h('p', { class: 'muted small' }, T.waterHelp(app.catalog.rules.waterMinProgressPct)))),
                ready
                    ? actionButton(T.harvest, () => app.act('/plots/harvest', { slot, plantSeq: seq }, {
                        done: (r) => { close(); app.toast(harvestText(app, r.harvested)); }
                    }), { key: 'harvest' })
                    : h('div', { class: 'stack-sm' },
                        actionButton([icon('water', { size: 18 }), ' ', plot.watered ? T.alreadyWatered : waterOpen ? T.water : countdown(plot.waterableAtMs, now, { format: T.waterFrom, done: T.water })],
                            () => app.act('/plots/water', { slot, plantSeq: seq }, { done: (r) => app.toast(`${T.watered}: ${duration(r.savedMs)} saved.`) }),
                            { key: 'water', disabled: !waterOpen, cls: 'btn-primary' }),
                        boosts.map(b => {
                            const used = (plot.boostsUsed || []).includes(b.id);
                            const have = M.boostCount(app, b.id);
                            const label = used ? T.boostUsed(b.name) : have ? T.boostUse(b.name, have) : T.boostNone(b.name);
                            return actionButton(label, () => app.act('/plots/boost', { slot, boostId: b.id, plantSeq: seq }, { done: () => app.toast(T.boostUsed(b.name)) }),
                                { key: `boost-${b.id}`, cls: 'btn-secondary', disabled: used || !have });
                        })),
                h('div', { class: 'row-actions' },
                    actionButton(T.remove, async () => {
                        const ok = await confirmDialog({ title: T.remove, text: T.removeConfirm, confirmText: T.remove, danger: true });
                        if (ok) await app.act('/plots/remove', { slot, plantSeq: seq }, { done: () => close() });
                    }, { key: 'remove', cls: 'btn-ghost btn-danger-text', small: true })));
            return body;
        }
    });
}

export function render(app) {
    const now = app.now();
    const plots = app.state.plots;
    const ready = plots.filter(p => M.isReady(p, now));
    const maxPlots = app.catalog.rules.maxPlots;
    const bench = app.state.upgrades.find(u => u.code === 'extra_bench');
    const benchMax = bench ? app.catalog.rules.starterPlots + bench.maxLevel : maxPlots;
    // Three blocks: what needs doing now, the benches, and goals. One column in the panel; on wide screens
    // the benches take the main column and the other two sit beside them (styles/app.css .grow-layout).
    const alerts = [renderSlot('grow.top', app), dailyCard(app), staffCard(app)].filter(Boolean);
    const goals = renderSlot('grow.bottom', app);
    return h('div', { class: 'view-body grow-layout' },
        alerts.length ? h('div', { class: 'grow-alerts stack' }, alerts) : null,
        h('div', { class: 'grow-benches stack' },
            section(T.benches, {
                count: T.benchCount(app.state.plotsOwned, benchMax),
                actions: ready.length >= 1 ? actionButton(T.harvestAll(ready.length), () => app.act('/plots/harvest-all', {}, {
                    done: (r) => app.toast(harvestText(app, r.harvested))
                }), { key: 'harvest-all', small: true }) : null
            }),
            h('div', { class: 'plots' }, plots.map(p => plotTile(app, p, now)), benchTile(app)),
            renderSlot('grow.benches', app)),
        goals ? h('div', { class: 'grow-goals stack' }, goals) : null);
}
