// Read helpers over the catalogue (GET /catalog: names and rules) and the state (GET /state). Nothing here
// decides anything the server decides; prices and timers shown here are what the server's formulas give
// (domain/economy.js sellPrice, domain/rules.js breedingPlan), and every action answer replaces the state.
import { artFor } from './art/plant.js';

export function variety(app, id) {
    const c = app.catalog;
    if (!c._byId) c._byId = new Map(c.varieties.map(v => [v.id, v]));
    const base = c._byId.get(id);
    if (base) return base;
    const hybrids = (app.state && app.state.hybrids) || [];
    return hybrids.find(h => h.id === id) || null;
}

export const varietyName = (app, id) => (variety(app, id) || {}).name || `Plant ${id}`;

export function art(app, id) {
    return artFor(variety(app, id), (x) => variety(app, x));
}

export function qualityName(app, band) {
    const q = app.catalog.quality.find(x => x.band === band);
    return q ? q.name : String(band);
}

export function seedCount(app, id) {
    const row = app.state.inventory.seeds.find(x => x.varietyId === id);
    return row ? row.quantity : 0;
}

export function boostCount(app, id) {
    const row = app.state.inventory.boosts.find(x => x.boostId === id);
    return row ? row.quantity : 0;
}

export function produceCount(app, varietyId, minQuality = 0) {
    return app.state.inventory.produce
        .filter(p => p.varietyId === varietyId && p.quality >= minQuality)
        .reduce((a, p) => a + p.quantity, 0);
}

export function demand(app, id) {
    return app.state.market.find(m => m.varietyId === id) || { varietyId: id, demandPct: 100, changePct: 0 };
}

/** Today's price for one unit: domain/economy.js sellPrice with the account's Market stall bonus. */
export function unitPrice(app, varietyId, quality) {
    const v = variety(app, varietyId);
    const q = app.catalog.quality.find(x => x.band === quality);
    if (!v || !q) return 0;
    const d = Math.min(140, Math.max(60, demand(app, varietyId).demandPct));
    const pricePct = (app.state.effects && app.state.effects.price_pct) || 0;
    return Math.max(1, Math.floor((v.basePrice * q.pricePct * d * (100 + pricePct)) / 1_000_000));
}

/** Growth 0..1 of a planted plot at the server time `now`. */
export function plotStage(plot, now) {
    if (!plot || plot.status === 'empty') return 0;
    const span = plot.readyAtMs - plot.plantedAtMs;
    if (span <= 0 || now >= plot.readyAtMs) return 1;
    return Math.max(0, Math.min(1, (now - plot.plantedAtMs) / span));
}

export const isReady = (plot, now) => plot.status !== 'empty' && now >= plot.readyAtMs;

/** domain/rules.js breedingPlan(), with the numbers from the catalogue. */
export function breedingPlan(app, idA, idB) {
    const a = variety(app, idA);
    const b = variety(app, idB);
    const r = app.catalog.rules.breeding;
    if (!a || !b) return null;
    const avg = Math.round((a.growMs + b.growMs) / 2);
    const durationMs = Math.min(r.maxMs, Math.max(r.minMs, Math.round((avg * r.timeFactorPct) / 100)));
    const feeCash = Math.ceil(((a.seedPrice + b.seedPrice) * r.feePct) / 100);
    return { durationMs, feeCash, seedsOut: r.seedsOut };
}

export function hybridOf(app, idA, idB) {
    const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
    return (app.state.hybrids || []).find(h => h.parents && h.parents[0] === lo && h.parents[1] === hi) || null;
}

export const discovered = (app, id) => app.state.discovered.some(d => d.varietyId === id);

export function upgradeName(app, code) {
    const n = app.catalog.upgrades.find(u => u.code === code);
    return n ? n.name : code;
}

export function staffType(app, code) {
    return app.catalog.staff.find(t => t.code === code) || null;
}
