// Market tab: NPC orders, selling to NPC buyers at today's demand, and the seed and plant-care shop.
import { h } from '../lib/dom.js';
import { money, count } from '../lib/format.js';
import { UI } from '../copy.js';
import { plantSvg } from '../art/plant.js';
import { icon } from '../art/icons.js';
import { confirmDialog } from '../ui/dialog.js';
import { actionButton, section, emptyState, countdown, segmented, stepper } from '../ui/widgets.js';
import { renderSlot } from '../slots.js';
import * as M from '../model.js';

const T = UI.market;

function mem(app) {
    if (!app.mem.market) app.mem.market = { section: 'orders', sellQty: {}, buyQty: {} };
    return app.mem.market;
}

function demandLine(app, varietyId) {
    const d = M.demand(app, varietyId);
    const change = d.changePct > 0 ? T.demandUp(d.changePct) : d.changePct < 0 ? T.demandDown(-d.changePct) : null;
    return `${T.demand(d.demandPct)}${change ? `, ${change}` : ''}`;
}

function ordersSection(app) {
    const now = app.now();
    const orders = app.state.orders;
    return h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, T.ordersIntro),
        orders.length ? h('ul', { class: 'cards', role: 'list' }, orders.map(o => {
            const name = M.varietyName(app, o.varietyId);
            const have = M.produceCount(app, o.varietyId, o.minQuality);
            const enough = have >= o.quantity;
            return h('li', { class: 'card' },
                h('div', { class: 'card-row' },
                    plantSvg(M.art(app, o.varietyId), { className: 'plant-art plant-art-sm' }),
                    h('div', { class: 'card-main' },
                        h('h2', { class: 'card-title' }, o.buyer),
                        h('p', null, T.wants(o.quantity, name, M.qualityName(app, o.minQuality))),
                        h('p', { class: 'muted small' }, T.youHave(have), ', ', countdown(o.expiresAtMs, now, { format: T.expires, done: T.expires('0 s') })))),
                h('div', { class: 'card-foot' },
                    h('span', { class: 'reward' }, T.reward(money(o.rewardCash), o.rewardXp)),
                    h('div', { class: 'row-actions' },
                        actionButton(T.decline, async () => {
                            const ok = await confirmDialog({ title: T.decline, text: T.declineConfirm(o.buyer), confirmText: T.decline, danger: true });
                            if (ok) await app.act('/orders/decline', { orderId: o.id });
                        }, { cls: 'btn-ghost', small: true, key: `decline-${o.id}` }),
                        actionButton(T.deliver, () => app.act('/orders/fill', { orderId: o.id }, {
                            done: (r) => app.toast(T.delivered(money(r.cash)))
                        }), { small: true, disabled: !enough, key: `deliver-${o.id}` }))));
        })) : emptyState(T.noOrders));
}

async function sellLines(app, lines) {
    let cash = 0;
    let units = 0;
    for (let i = 0; i < lines.length; i += 20) {
        const r = await app.act('/sell', { lines: lines.slice(i, i + 20) });
        if (!r) break;
        cash += r.cash;
        units += r.units;
    }
    if (units) app.toast(T.sold(count(units), money(cash)));
}

function sellSection(app) {
    const m = mem(app);
    const rows = app.state.inventory.produce.filter(p => p.quantity > 0)
        .sort((a, b) => M.varietyName(app, a.varietyId).localeCompare(M.varietyName(app, b.varietyId)) || a.quality - b.quality);
    if (!rows.length) {
        return emptyState(T.nothingToSell, h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => app.go('grow') } }, UI.tabHeadings.grow));
    }
    const total = rows.reduce((a, r) => a + M.unitPrice(app, r.varietyId, r.quality) * r.quantity, 0);
    const units = rows.reduce((a, r) => a + r.quantity, 0);
    return h('div', { class: 'stack' },
        actionButton(T.sellAll(money(total)), async () => {
            const ok = await confirmDialog({ title: T.sellAll(money(total)), text: T.sellAllConfirm(count(units), money(total)), confirmText: T.sellAll(money(total)) });
            if (ok) await sellLines(app, rows.map(r => ({ varietyId: r.varietyId, quality: r.quality, quantity: r.quantity })));
        }, { key: 'sell-all', cls: 'btn-secondary' }),
        h('ul', { class: 'cards', role: 'list' }, rows.map(r => {
            const key = `${r.varietyId}:${r.quality}`;
            const unit = M.unitPrice(app, r.varietyId, r.quality);
            const qty = Math.min(r.quantity, m.sellQty[key] || r.quantity);
            const name = M.varietyName(app, r.varietyId);
            const id = `sell-${r.varietyId}-${r.quality}`;
            const btn = actionButton(T.sellFor(money(unit * qty)), async () => {
                const n = Math.min(r.quantity, m.sellQty[key] || r.quantity);
                await sellLines(app, [{ varietyId: r.varietyId, quality: r.quality, quantity: n }]);
                delete m.sellQty[key];
            }, { small: true, key: `${id}-go` });
            return h('li', { class: 'card' },
                h('div', { class: 'card-row' },
                    plantSvg(M.art(app, r.varietyId), { className: 'plant-art plant-art-sm' }),
                    h('div', { class: 'card-main' },
                        h('h2', { class: 'card-title' }, name, ' ', h('span', { class: ['chip', r.quality >= 2 && 'chip-accent'] }, M.qualityName(app, r.quality))),
                        h('p', { class: 'small' }, `${T.inStock(count(r.quantity))}, ${T.each(money(unit))}`),
                        h('p', { class: 'muted small' }, demandLine(app, r.varietyId)))),
                h('div', { class: 'card-foot' },
                    stepper({
                        id, key: id, label: `${T.quantity}, ${name}`, value: qty, min: 1, max: r.quantity,
                        onChange: (n) => { m.sellQty[key] = n; btn.textContent = T.sellFor(money(unit * n)); }
                    }),
                    btn));
        })));
}

function buyRow(app, { key, art, name, chip, sub, price, owned, locked, kind, itemId }) {
    const m = mem(app);
    if (locked) {
        return h('li', { class: 'card card-locked' },
            h('div', { class: 'card-row' }, art, h('div', { class: 'card-main' },
                h('h2', { class: 'card-title' }, name), h('p', { class: 'muted small' }, icon('lock', { size: 14 }), ' ', locked))));
    }
    const qty = m.buyQty[key] || 1;
    const cash = app.state.account.cash;
    const maxAfford = Math.max(1, Math.min(1000, Math.floor(cash / Math.max(1, price))));
    const id = `buy-${key}`;
    const btn = actionButton(T.buyFor(money(price * qty)), async () => {
        const n = m.buyQty[key] || 1;
        await app.act('/shop/buy', { kind, itemId, quantity: n }, { done: () => app.toast(T.bought(n, kind === 'seed' ? `${name} seeds` : name)) });
    }, { small: true, key: `${id}-go`, disabled: price * qty > cash });
    return h('li', { class: 'card' },
        h('div', { class: 'card-row' }, art,
            h('div', { class: 'card-main' },
                h('h2', { class: 'card-title' }, name, chip ? [' ', h('span', { class: 'chip' }, chip)] : null),
                h('p', { class: 'small' }, `${T.each(money(price))}, ${UI.grow.owned(count(owned))}`),
                sub ? h('p', { class: 'muted small' }, sub) : null)),
        h('div', { class: 'card-foot' },
            stepper({
                id, key: id, label: `${T.quantity}, ${name}`, value: qty, min: 1, max: Math.max(qty, maxAfford),
                onChange: (n) => {
                    m.buyQty[key] = n;
                    btn.textContent = T.buyFor(money(price * n));
                    btn.disabled = price * n > app.state.account.cash;
                }
            }),
            btn));
}

function shopSection(app) {
    const level = app.state.account.level;
    const base = [...app.catalog.varieties].sort((a, b) => a.unlockLevel - b.unlockLevel || a.id - b.id);
    const open = base.filter(v => v.unlockLevel <= level);
    const locked = base.filter(v => v.unlockLevel > level).slice(0, 3);
    const hybrids = app.state.hybrids || [];
    const speed = (app.state.effects && app.state.effects.speed_pct) || 0;
    const seedRow = (v, lockedText = null) => buyRow(app, {
        key: `seed-${v.id}`, kind: 'seed', itemId: v.id, name: v.name,
        art: plantSvg(M.art(app, v.id), { className: 'plant-art plant-art-sm' }),
        chip: v.hybrid ? T.hybridSeed : null,
        sub: lockedText ? null : `${UI.grow.growsIn(fmtGrow(app, v, speed))}`,
        price: v.seedPrice, owned: M.seedCount(app, v.id), locked: lockedText
    });
    return h('div', { class: 'stack' },
        section(T.seeds),
        h('ul', { class: 'cards', role: 'list' },
            open.map(v => seedRow(v)),
            hybrids.map(v => seedRow(v)),
            locked.map(v => seedRow(v, T.unlocksAt(v.unlockLevel)))),
        section(T.boosts),
        h('ul', { class: 'cards', role: 'list' }, app.catalog.boosts.map(b => buyRow(app, {
            key: `boost-${b.id}`, kind: 'boost', itemId: b.id, name: b.name,
            art: h('span', { class: 'item-icon' }, icon(b.effect.kind === 'time_cut_pct' ? 'clock' : 'water', { size: 22 })),
            sub: b.effect.kind === 'time_cut_pct' ? T.boostText.time_cut_pct(b.effect.amount) : T.boostText.quality_roll,
            price: b.price, owned: M.boostCount(app, b.id), locked: b.unlockLevel > level ? T.unlocksAt(b.unlockLevel) : null
        }))),
        h('p', { class: 'muted small' }, T.benchesNote, ' ',
            h('button', { type: 'button', class: 'link-btn', on: { click: () => app.go('upgrades', { section: 'upgrades' }) } }, UI.tabs.upgrades)));
}

function fmtGrow(app, v, speed) {
    const ms = Math.max(app.catalog.rules.minGrowMs, Math.round((v.growMs * 100) / (100 + speed)));
    const mins = Math.round(ms / 60000);
    return mins >= 1 ? `${mins} m` : `${Math.round(ms / 1000)} s`;
}

export function render(app) {
    const m = mem(app);
    const body = m.section === 'sell' ? sellSection(app) : m.section === 'shop' ? shopSection(app) : ordersSection(app);
    return h('div', { class: 'view-body' },
        renderSlot('market.top', app),
        segmented(UI.tabHeadings.market, [['orders', `${T.sections.orders}${app.state.orders.length ? ` (${app.state.orders.length})` : ''}`], ['sell', T.sections.sell], ['shop', T.sections.shop]], m.section,
            (value) => { m.section = value; app.render({ focus: `seg-${UI.tabHeadings.market}-${value}` }); }),
        body);
}
