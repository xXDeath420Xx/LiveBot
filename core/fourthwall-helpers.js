import crypto from 'crypto';

export function generateConnectionToken() {
    return crypto.randomBytes(24).toString('base64url');
}

export function pseudonymFor(customerId, guildId) {
    if (!customerId) customerId = 'anon';
    const hash = crypto.createHash('sha256').update(`${guildId}:${customerId}`).digest();
    const n = hash.readUInt32BE(0) % 9000 + 1000;
    return `Supporter #${n}`;
}

const MD_SPECIAL = /[\\`*_~|>#-]/g;
const MENTION_PATTERNS = [
    /@everyone/gi,
    /@here/gi,
    /<@&\d+>/g,
    /<@!?\d+>/g,
    /<#\d+>/g
];

export function sanitizeUserText(text) {
    if (text == null) return '';
    let out = String(text);
    for (const pat of MENTION_PATTERNS) {
        out = out.replace(pat, '[mention removed]');
    }
    out = out.replace(MD_SPECIAL, c => '\\' + c);
    return out;
}

export function truncate(text, max = 1024) {
    if (text == null) return '';
    const s = String(text);
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

export function formatCurrency(amountMinorUnits, currencyCode) {
    const value = Number(amountMinorUnits) / 100;
    if (!currencyCode) {
        return value.toFixed(2);
    }
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currencyCode
        }).format(value);
    } catch {
        return `${value.toFixed(2)} ${currencyCode}`;
    }
}

// Maps FW event type strings to internal categories used in fourthwall_event_routing.
export const EVENT_CATEGORY_MAP = {
    ORDER_PLACED: 'orders',
    ORDER_UPDATED: 'orders',
    GIFT_PURCHASE: 'orders',
    ORDER_DONATION: 'donations',
    SUBSCRIPTION_PURCHASED: 'memberships',
    SUBSCRIPTION_CHANGED: 'memberships',
    SUBSCRIPTION_EXPIRED: 'memberships',
    GIVEAWAY_DRAW_STARTED: 'giveaways',
    GIVEAWAY_DRAW_ENDED: 'giveaways',
    PROMOTION_CREATED: 'promotions',
    PROMOTION_UPDATED: 'promotions',
    PROMOTION_STATUS_CHANGED: 'promotions',
    NEWSLETTER_SUBSCRIBED: 'newsletter',
    THANK_YOU_MESSAGE_SENT: 'thank_you',
    CART_ABANDONED_1H: 'cart_abandoned',
    CART_ABANDONED_24H: 'cart_abandoned',
    CART_ABANDONED_72H: 'cart_abandoned'
};

export const ALL_EVENT_TYPES = Object.keys(EVENT_CATEGORY_MAP);

export const EMBED_DEFAULT_COLOR = 0xFF6B35;

export function parseHexColor(hex) {
    if (!hex) return EMBED_DEFAULT_COLOR;
    const m = String(hex).replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(m)) return EMBED_DEFAULT_COLOR;
    return parseInt(m, 16);
}
