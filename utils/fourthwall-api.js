import axios from 'axios';
import crypto from 'crypto';
import logger from './logger.js';

const PLATFORM_BASE = process.env.FOURTHWALL_API_BASE_URL || 'https://api.fourthwall.com';
const STOREFRONT_BASE = process.env.FOURTHWALL_STOREFRONT_BASE_URL || 'https://storefront-api.fourthwall.com';
const DEFAULT_TIMEOUT_MS = 15_000;

export function basicAuthHeader(user, pass) {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

export function verifyHmac(rawBody, sigHex, secret) {
    if (!rawBody || !sigHex || !secret) return false;
    try {
        // Strip optional "sha256=" prefix some webhook senders use.
        const cleanSig = String(sigHex).replace(/^sha256=/i, '').trim();
        if (!/^[0-9a-fA-F]+$/.test(cleanSig)) return false;
        const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
        const provided = Buffer.from(cleanSig, 'hex');
        if (provided.length !== expected.length) return false;
        return crypto.timingSafeEqual(provided, expected);
    } catch (err) {
        logger.warn('[FW API] HMAC verify error', { err: err.message });
        return false;
    }
}

export function buildErrorMessage(resp) {
    if (!resp) return 'Fourthwall API request failed (no response)';
    if (resp.status === 401) return 'Fourthwall credentials rejected — check API username and password.';
    if (resp.status === 403) return 'Fourthwall API denied access — token lacks required permission.';
    if (resp.status === 404) return 'Fourthwall resource not found.';
    if (resp.status === 429) return 'Fourthwall rate limit hit — retry shortly.';
    const data = resp.data || {};
    const msg = data.message || data.error || data.error_description || `HTTP ${resp.status}`;
    return `Fourthwall API error: ${msg} (${resp.status})`;
}

function makePlatformClient(apiUser, apiPass) {
    return axios.create({
        baseURL: PLATFORM_BASE,
        timeout: DEFAULT_TIMEOUT_MS,
        headers: {
            'Authorization': basicAuthHeader(apiUser, apiPass),
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'CertiFriedUtility/1.0 (+https://github.com/xXDeath420Xx)'
        },
        validateStatus: () => true
    });
}

function makeStorefrontClient(storefrontToken) {
    const headers = {
        'Accept': 'application/json',
        'User-Agent': 'CertiFriedUtility/1.0'
    };
    if (storefrontToken) headers['X-Storefront-Token'] = storefrontToken;
    return axios.create({
        baseURL: STOREFRONT_BASE,
        timeout: DEFAULT_TIMEOUT_MS,
        headers,
        validateStatus: () => true
    });
}

async function requireOk(promise, action) {
    const resp = await promise;
    if (resp.status < 200 || resp.status >= 300) {
        const msg = buildErrorMessage(resp);
        const err = new Error(`${action}: ${msg}`);
        err.status = resp.status;
        err.responseData = resp.data;
        throw err;
    }
    return resp.data;
}

export function platformClient(apiUser, apiPass) {
    const c = makePlatformClient(apiUser, apiPass);
    return {
        async getShop() {
            return requireOk(c.get('/v1/shop'), 'getShop');
        },
        async listWebhooks() {
            return requireOk(c.get('/v1/webhooks'), 'listWebhooks');
        },
        async createWebhook({ url, eventType }) {
            return requireOk(c.post('/v1/webhooks', { url, eventType }), `createWebhook(${eventType})`);
        },
        async deleteWebhook(id) {
            return requireOk(c.delete(`/v1/webhooks/${id}`), `deleteWebhook(${id})`);
        },
        async listOrders({ since, limit = 25 } = {}) {
            const params = { limit };
            if (since) params.since = since;
            return requireOk(c.get('/v1/orders', { params }), 'listOrders');
        },
        async listDonations({ since, limit = 25 } = {}) {
            const params = { limit };
            if (since) params.since = since;
            return requireOk(c.get('/v1/donations', { params }), 'listDonations');
        },
        async listMembers({ limit = 25 } = {}) {
            return requireOk(c.get('/v1/memberships/members', { params: { limit }}), 'listMembers');
        },
        async listPromotions() {
            return requireOk(c.get('/v1/promotions'), 'listPromotions');
        },
        async listGiveaways() {
            return requireOk(c.get('/v1/giveaways'), 'listGiveaways');
        },
        async triggerGiveawayDraw(drawId) {
            return requireOk(c.post(`/v1/giveaways/${drawId}/draw`), `triggerGiveawayDraw(${drawId})`);
        }
    };
}

export function storefrontClient(storefrontToken) {
    const c = makeStorefrontClient(storefrontToken);
    return {
        async getShop() {
            return requireOk(c.get('/v1/shop'), 'storefront.getShop');
        },
        async getProduct(slug) {
            return requireOk(c.get(`/v1/products/${encodeURIComponent(slug)}`), `storefront.getProduct(${slug})`);
        },
        async getCollection(slug) {
            return requireOk(c.get(`/v1/collections/${encodeURIComponent(slug)}`), `storefront.getCollection(${slug})`);
        },
        async listCollections() {
            return requireOk(c.get('/v1/collections'), 'storefront.listCollections');
        },
        async searchProducts(query) {
            return requireOk(c.get('/v1/products', { params: { q: query }}), `storefront.searchProducts(${query})`);
        }
    };
}

export default { platformClient, storefrontClient, verifyHmac, basicAuthHeader, buildErrorMessage };
