// Phase 4 endgame: Replant (reset for a lasting bonus) and decorations (cosmetic, bought with cash).
// Registered in phase4.js: the Replant card on the Upgrades tab, the decoration shop as its third section,
// and the placed decorations as a strip under the benches on the Grow tab.
import { h } from '../lib/dom.js';
import { money } from '../lib/format.js';
import { UI } from '../copy.js';
import { decorSvg } from '../art/decor.js';
import { openDialog } from '../ui/dialog.js';
import { actionButton, section, progress } from '../ui/widgets.js';

const R = UI.replant;
const D = UI.decor;

// ------------------------------------------------------------------ Replant

function replantConfirm(app) {
    const rp = app.state.replant;
    openDialog({
        title: R.confirmTitle,
        render: (close) => {
            const cur = app.state.replant;
            if (!cur || cur.count !== rp.count || !cur.available) return null;
            return h('div', { class: 'stack' },
                h('p', { class: 'dialog-text' }, R.bonusNext(cur.next.pricePct, cur.next.xpPct)),
                h('div', { class: 'replant-lists' },
                    h('div', null, h('h3', { class: 'quest-group' }, R.resets), h('ul', { class: 'plain-list' }, R.resetList.map(x => h('li', null, x)))),
                    h('div', null, h('h3', { class: 'quest-group' }, R.keeps), h('ul', { class: 'plain-list' }, R.keepList.map(x => h('li', null, x))))),
                h('p', { class: 'muted small' }, R.gets),
                h('div', { class: 'row-actions' },
                    h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => close() } }, UI.cancel),
                    actionButton(R.confirm, () => app.act('/replant', { prestige: rp.count }, {
                        done: (r) => { close(); app.toast(R.done(r.prestige)); app.go('grow'); }
                    }), { cls: 'btn-danger', key: 'replant-confirm' })));
        }
    });
}

export function replantCard(app) {
    const rp = app.state.replant;
    if (!rp) return null;
    const level = app.state.account.level;
    const rules = app.catalog.rules.replant || { pricePct: 10, xpPct: 10 };
    const review = app.state.account.review;
    const why = review ? R.reviewOff : rp.available ? R.ready : R.need(rp.minLevel, level);
    // Compact until it matters: the pitch shows once Replant is open or has been used.
    return h('section', { class: 'card stack-sm', 'aria-labelledby': 'gh-replant-title' },
        h('div', { class: 'card-foot' },
            h('h2', { class: 'card-title', id: 'gh-replant-title' }, R.title, rp.count ? [' ', h('span', { class: 'chip chip-accent' }, R.count(rp.count))] : null),
            h('button', {
                type: 'button', class: ['btn', 'btn-sm', rp.available && !review ? 'btn-primary' : 'btn-secondary'], dataset: { key: 'replant' }, disabled: !rp.available || review,
                'aria-describedby': 'gh-replant-why', on: { click: () => replantConfirm(app) }
            }, R.action)),
        rp.available || rp.count ? h('p', { class: 'small' }, R.pitch(rules.pricePct, rules.xpPct)) : null,
        rp.count ? h('p', { class: 'small' }, R.bonusNow(rp.bonus.pricePct, rp.bonus.xpPct)) : null,
        rp.available ? null : progress(Math.min(1, level / rp.minLevel), { label: R.need(rp.minLevel, level), cls: 'progress-thin' }),
        h('p', { class: 'muted small', id: 'gh-replant-why' }, why));
}

// ------------------------------------------------------------------ decorations

function owned(app) {
    return new Map(((app.state.cosmetics && app.state.cosmetics.decorations) || []).map(d => [d.code, d]));
}

export function decorSection(app) {
    const list = app.catalog.decorations || [];
    const mine = owned(app);
    const max = (app.state.cosmetics && app.state.cosmetics.maxPlaced) || app.catalog.rules.maxPlacedDecorations || 6;
    const shown = [...mine.values()].filter(d => d.placed).length;
    const cash = app.state.account.cash;
    const level = app.state.account.level;
    return h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, D.intro(max)),
        section(D.section, { count: D.shown(shown, max) }),
        h('ul', { class: 'cards cards-decor', role: 'list' }, list.filter(d => d.sold || mine.has(d.code)).concat(list.filter(d => !d.sold && !mine.has(d.code))).map(d => {
            const have = mine.get(d.code);
            const id = `decor-${d.code}-why`;
            let foot;
            if (have) {
                const full = !have.placed && shown >= max;
                foot = h('div', { class: 'card-foot' },
                    h('span', { class: 'chip' }, D.owned),
                    actionButton(have.placed ? D.hide : D.show, () => app.act('/decorations/place', { code: d.code, placed: !have.placed }),
                        { cls: 'btn-secondary', small: true, key: `decor-place-${d.code}`, disabled: full, describedBy: full ? id : null }));
                if (full) foot = [foot, h('p', { class: 'muted small', id }, D.full(max))];
            } else if (!d.sold) {
                foot = h('p', { class: 'muted small' }, D.seasonOnly);
            } else {
                const locked = level < d.unlockLevel;
                foot = h('div', { class: 'card-foot' },
                    h('span', { class: 'muted small', id }, locked ? D.opensAt(d.unlockLevel) : ''),
                    actionButton(D.buy(money(d.price)), () => app.act('/decorations/buy', { code: d.code }, { done: () => app.toast(D.bought(d.name)) }),
                        { small: true, key: `decor-buy-${d.code}`, disabled: locked || d.price > cash, describedBy: locked ? id : null }));
            }
            return h('li', { class: ['card', !have && (!d.sold || level < d.unlockLevel) && 'card-locked'] },
                h('div', { class: 'card-row' }, decorSvg(d.code, { className: 'decor-art' }),
                    h('div', { class: 'card-main' }, h('h2', { class: 'card-title' }, d.name), d.sold ? h('p', { class: 'small' }, money(d.price)) : null)),
                foot);
        })));
}

/** The decorations a player chose to show, under the benches. */
export function decorStrip(app) {
    const placed = ((app.state.cosmetics && app.state.cosmetics.decorations) || []).filter(d => d.placed);
    if (!placed.length) return null;
    const names = new Map((app.catalog.decorations || []).map(d => [d.code, d.name]));
    return h('ul', { class: 'decor-strip', role: 'list', 'aria-label': D.stripLabel },
        placed.map(d => h('li', { class: 'decor-item' }, decorSvg(d.code), h('span', { class: 'decor-name' }, names.get(d.code) || d.code))));
}
