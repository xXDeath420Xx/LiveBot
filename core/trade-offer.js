/*
 * Trade offers — the data shape stored in trades.initiator_offer / trades.recipient_offer, and the
 * small text grammar the counter-offer form uses. Dependency-free (tests/trade-offer.test.js).
 *
 * Offer JSON:  { "coins": 500, "items": [{ "id": 12, "qty": 2 }], "cards": [45, 46] }
 *   coins  wallet currency (user_economy.wallet)
 *   items  shop items from shop_inventory (item_id + quantity)
 *   cards  collectible cards from card_collection (row id = the "Card ID" users see)
 *
 * Grammar (comma, semicolon or newline separated; case-insensitive):
 *   500 | 500 coins | 1.5k | $500 | coins 500     -> coins (several coin tokens add up)
 *   item 12 | item 12 x3 | #12 x3 | 12x3 | 3x #12 -> shop item 12, quantity 3 (default 1)
 *   card 45 | card #45 | c45                      -> card 45
 *   nothing | none | -                            -> nothing
 */

export const MAX_ITEM_ENTRIES = 10;
export const MAX_CARDS = 10;
export const MAX_COINS = 1_000_000_000_000;
export const MAX_ITEM_QTY = 1_000_000;

export function emptyOffer() {
    return { coins: 0, items: [], cards: [] };
}

function toPositiveInt(v) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * Coerce stored/untrusted data into a clean offer: integers only, duplicate items summed,
 * duplicate cards dropped. Accepts a JSON string or an object.
 */
export function normalizeOffer(raw) {
    let obj = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw); } catch { obj = null; }
    }
    if (!obj || typeof obj !== 'object') return emptyOffer();

    const coins = Math.min(toPositiveInt(obj.coins), MAX_COINS);
    const itemMap = new Map();
    for (const it of Array.isArray(obj.items) ? obj.items : []) {
        const id = toPositiveInt(it?.id);
        const qty = toPositiveInt(it?.qty ?? 1);
        if (!id || !qty) continue;
        itemMap.set(id, Math.min((itemMap.get(id) || 0) + qty, MAX_ITEM_QTY));
    }
    const cards = [];
    for (const c of Array.isArray(obj.cards) ? obj.cards : []) {
        const id = toPositiveInt(c);
        if (id && !cards.includes(id)) cards.push(id);
    }
    return {
        coins,
        items: [...itemMap].map(([id, qty]) => ({ id, qty })),
        cards,
    };
}

export function isEmptyOffer(offer) {
    const o = normalizeOffer(offer);
    return o.coins === 0 && o.items.length === 0 && o.cards.length === 0;
}

/** True when either side moves coins or shop items (the parts governed by the economy settings). */
export function involvesEconomy(a, b) {
    const x = normalizeOffer(a);
    const y = normalizeOffer(b);
    return x.coins > 0 || y.coins > 0 || x.items.length > 0 || y.items.length > 0;
}

function parseAmount(text) {
    const m = String(text).trim().toLowerCase().replace(/,/g, '').match(/^\$?(\d+(?:\.\d+)?)(k|m)?$/);
    if (!m) return null;
    let n = Number(m[1]);
    if (m[2] === 'k') n *= 1_000;
    if (m[2] === 'm') n *= 1_000_000;
    n = Math.round(n);
    return Number.isSafeInteger(n) ? n : null;
}

const RE_COINS = [
    /^(?:coins?|money|cash|\$)\s*:?\s*(\$?[\d.,]+[km]?)$/i,
    /^(\$?[\d.,]+[km]?)\s*(?:coins?|c|money|cash|\$)?$/i,
];
const RE_ITEM = [
    /^(?:item|i)\s*#?\s*(\d+)\s*(?:[x×*]\s*(\d+))?$/i,
    /^#\s*(\d+)\s*(?:[x×*]\s*(\d+))?$/i,
    /^(\d+)\s*[x×*]\s*(\d+)$/i,
];
const RE_ITEM_QTY_FIRST = /^(\d+)\s*[x×*]\s*(?:item\s*)?#\s*(\d+)$/i;
const RE_ITEM_QTY_FIRST_WORD = /^(\d+)\s*[x×*]\s*item\s*#?\s*(\d+)$/i;
const RE_CARD = /^(?:card|c)\s*#?\s*(\d+)$/i;
const RE_NOTHING = /^(?:nothing|none|no|-|—|n\/a)$/i;

/**
 * Parse the grammar into an offer.
 * @returns {{ offer: object, errors: string[] }}
 */
export function parseOfferText(text) {
    const out = { coins: 0, items: [], cards: [] };
    const errors = [];
    // Commas separate tokens, except a thousands separator ("1,500 coins").
    const tokens = String(text ?? '').split(/[;\n]+|,(?!\d{3}(?:\D|$))/).map(t => t.trim()).filter(Boolean);

    for (const token of tokens) {
        if (RE_NOTHING.test(token)) continue;

        let m = token.match(RE_CARD);
        if (m) { out.cards.push(Number(m[1])); continue; }

        m = token.match(RE_ITEM_QTY_FIRST) || token.match(RE_ITEM_QTY_FIRST_WORD);
        if (m) { out.items.push({ id: Number(m[2]), qty: Number(m[1]) }); continue; }

        let matched = false;
        for (const re of RE_ITEM) {
            m = token.match(re);
            if (m) {
                out.items.push({ id: Number(m[1]), qty: m[2] ? Number(m[2]) : 1 });
                matched = true;
                break;
            }
        }
        if (matched) continue;

        for (const re of RE_COINS) {
            m = token.match(re);
            if (m) {
                const n = parseAmount(m[1]);
                if (n === null || n <= 0) break;
                out.coins += n;
                matched = true;
                break;
            }
        }
        if (matched) continue;

        errors.push(`I couldn't read "${token.slice(0, 40)}" — use e.g. \`500 coins\`, \`item 12 x2\` or \`card 45\`.`);
    }

    if (out.coins > MAX_COINS) errors.push(`That's more coins than a trade can carry (max ${MAX_COINS.toLocaleString()}).`);
    const offer = normalizeOffer(out);
    if (offer.items.length > MAX_ITEM_ENTRIES) errors.push(`At most ${MAX_ITEM_ENTRIES} different items per side.`);
    if (offer.cards.length > MAX_CARDS) errors.push(`At most ${MAX_CARDS} cards per side.`);
    return { offer, errors };
}

/** The canonical grammar text for an offer (used to prefill the counter-offer form). */
export function offerToText(offer) {
    const o = normalizeOffer(offer);
    const parts = [];
    if (o.coins) parts.push(`${o.coins} coins`);
    for (const it of o.items) parts.push(it.qty > 1 ? `item ${it.id} x${it.qty}` : `item ${it.id}`);
    for (const c of o.cards) parts.push(`card ${c}`);
    return parts.join(', ') || 'nothing';
}

/**
 * Human-readable lines for an offer.
 * @param {object} offer
 * @param {object} [ctx]
 * @param {Map<number, {name:string, emoji?:string}>} [ctx.items] shop item names by id
 * @param {Map<number, {name:string, rarity?:string, power?:number}>} [ctx.cards] card names by id
 * @param {(n:number)=>string} [ctx.money] currency formatter
 */
export function describeOffer(offer, ctx = {}) {
    const o = normalizeOffer(offer);
    const money = ctx.money || (n => `${n.toLocaleString()} coins`);
    const lines = [];
    if (o.coins) lines.push(money(o.coins));
    for (const it of o.items) {
        const meta = ctx.items?.get(it.id);
        const name = meta ? `${meta.emoji ? meta.emoji + ' ' : ''}${meta.name}` : `Item #${it.id}`;
        lines.push(`${it.qty}x ${name} (ID ${it.id})`);
    }
    for (const id of o.cards) {
        const meta = ctx.cards?.get(id);
        lines.push(meta
            ? `🃏 ${meta.name}${meta.rarity ? ` — ${meta.rarity}` : ''}${meta.power ? `, power ${meta.power}` : ''} (Card #${id})`
            : `🃏 Card #${id}`);
    }
    return lines;
}

/**
 * Shape a trades row for the dashboard Trading page (dashboard/views/partials/manage/trading.ejs).
 * `labels` turns an offer into display strings (shop item / card names); falls back to ids.
 */
export function toDashboardRow(row, labels = null) {
    const a = normalizeOffer(row.initiator_offer);
    const b = normalizeOffer(row.recipient_offer);
    const itemLabels = (o) => {
        if (labels) return labels({ ...o, coins: 0 });
        return [
            ...o.items.map(it => `${it.qty}x Item #${it.id}`),
            ...o.cards.map(c => `Card #${c}`),
        ];
    };
    return {
        trade_id: row.id,
        initiator_id: row.initiator_id,
        partner_id: row.recipient_id,
        initiator_items: itemLabels(a),
        initiator_currency: a.coins,
        partner_items: itemLabels(b),
        partner_currency: b.coins,
        status: row.status,
        awaiting_id: row.awaiting_id || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at || null,
        expires_at: row.expires_at || null,
    };
}

export default {
    MAX_ITEM_ENTRIES, MAX_CARDS, MAX_COINS, MAX_ITEM_QTY,
    emptyOffer, normalizeOffer, isEmptyOffer, involvesEconomy, parseOfferText, offerToText, describeOffer, toDashboardRow,
};
