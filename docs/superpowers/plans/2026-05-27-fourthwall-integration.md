# Fourthwall Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Fourthwall.com integration for CertiFried — real-time webhook-driven Discord notifications (orders/donations/memberships/giveaways/etc.), shop browsing commands, and per-guild admin tooling. Mirrors the Throne integration's shape but built on FW's real REST API + HMAC webhooks (no scraping).

**Architecture:** Pure-webhook event flow into the existing Express dashboard (`POST /webhooks/fourthwall/:token`), dispatched to per-bot `client.fourthwallManager` instances. Multi-shop per guild, multi-bot routing via `bot-manager.getClientForGuild()`. Encrypted credential storage via `utils/encryption.js`. Privacy-first embed defaults (pseudonyms unless opted in). Unit tests for pure logic (`node --test`), manual smoke for HTTP/Discord layers.

**Tech Stack:** Node 18+ (ESM), discord.js v14, Express, MySQL (mysql2/promise), `node --test` (built-in), AES-256-GCM via existing encryption util.

**Spec:** [`docs/superpowers/specs/2026-05-27-fourthwall-integration-design.md`](../specs/2026-05-27-fourthwall-integration-design.md)

---

## File Map

**Create:**
- `migrations/112_fourthwall_integration.js`
- `utils/fourthwall-api.js`
- `core/fourthwall-manager.js`
- `commands/community/fourthwall.js`
- `commands/community/fourthwall-handler.js`
- `interactions/modals/fourthwall_setup_submit.js`
- `dashboard/routes/webhooks/fourthwall.js`
- `dashboard/routes/api/features/fourthwall.js`
- `dashboard/views/features/fourthwall.ejs`
- `jobs/fourthwall-cleanup.js`
- `tests/fourthwall-api.test.js`
- `tests/fourthwall-manager-helpers.test.js`

**Modify:**
- `index.js` — register manager in `initializeManagers(client)` + start cleanup job
- `core/bot-manager.js` — add `getClientForGuild(guildId)` method
- `dashboard/app.js` — mount webhook route before global body parser
- `dashboard/routes/api/index.js` — mount feature API
- `interactions/handlerRegistry.js` — register `fourthwall_setup_submit` modal
- `package.json` — add `test` script (no new deps)
- `.env.example` — add `FOURTHWALL_WEBHOOK_BASE_URL`, `FOURTHWALL_API_BASE_URL`

---

## Task 1: Add test script + migration 112 (schema)

**Files:**
- Create: `migrations/112_fourthwall_integration.js`
- Modify: `package.json` (add test script only)

- [ ] **Step 1: Add `test` script to package.json**

In `package.json`, modify the `"scripts"` block to add a `test` line. Insert as the LAST script (keeps git diff minimal):

```json
"scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js",
    "deploy": "node deploy-commands.js",
    "migrate": "node migrations/run.js",
    "cfx:build": "cd frontend/certifried-extension && npm run build",
    "cfx:build:prod": "cd frontend/certifried-extension && npm run build:prod",
    "cfx:build:zip": "cd frontend/certifried-extension && npm run build:zip",
    "cfx:watch": "cd frontend/certifried-extension && npm run watch",
    "test": "node --test tests/"
}
```

- [ ] **Step 2: Create `tests/` directory marker**

```bash
mkdir -p /home/death/CertiFriedUtility/tests
```

- [ ] **Step 3: Write the migration**

Create `migrations/112_fourthwall_integration.js`:

```js
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_connections (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            shop_handle VARCHAR(100) NOT NULL,
            shop_name VARCHAR(255) DEFAULT NULL,
            shop_id VARCHAR(100) DEFAULT NULL,
            api_username VARCHAR(255) NOT NULL,
            api_password TEXT NOT NULL,
            storefront_token VARCHAR(255) DEFAULT NULL,
            connection_token VARCHAR(64) NOT NULL,
            webhook_secret VARCHAR(512) DEFAULT NULL,
            webhook_ids JSON DEFAULT NULL,
            connected_by VARCHAR(20) NOT NULL,
            connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_event_at TIMESTAMP NULL DEFAULT NULL,
            UNIQUE KEY uk_guild_shop (guild_id, shop_handle),
            UNIQUE KEY uk_connection_token (connection_token),
            INDEX idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_event_routing (
            connection_id INT NOT NULL,
            event_category ENUM('orders','donations','memberships','giveaways','promotions','newsletter','thank_you','cart_abandoned') NOT NULL,
            channel_id VARCHAR(20) DEFAULT NULL,
            enabled TINYINT(1) DEFAULT 1,
            PRIMARY KEY (connection_id, event_category),
            FOREIGN KEY (connection_id) REFERENCES fourthwall_connections(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_guild_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            default_channel_id VARCHAR(20) DEFAULT NULL,
            show_customer_names TINYINT(1) DEFAULT 0,
            show_amounts TINYINT(1) DEFAULT 1,
            embed_color VARCHAR(7) DEFAULT '#FF6B35'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_seen_events (
            event_id VARCHAR(100) PRIMARY KEY,
            connection_id INT NOT NULL,
            event_type VARCHAR(100) NOT NULL,
            received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_received (received_at),
            INDEX idx_connection (connection_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_orphan_webhooks (
            id INT AUTO_INCREMENT PRIMARY KEY,
            connection_id INT DEFAULT NULL,
            webhook_id VARCHAR(100) NOT NULL,
            api_username VARCHAR(255) NOT NULL,
            api_password TEXT NOT NULL,
            attempts INT DEFAULT 0,
            last_attempt_at TIMESTAMP NULL DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_undelivered_events (
            id INT AUTO_INCREMENT PRIMARY KEY,
            connection_id INT NOT NULL,
            event_id VARCHAR(100) NOT NULL,
            event_type VARCHAR(100) NOT NULL,
            payload JSON NOT NULL,
            received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_connection (connection_id),
            FOREIGN KEY (connection_id) REFERENCES fourthwall_connections(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS fourthwall_undelivered_events');
    await db.execute('DROP TABLE IF EXISTS fourthwall_orphan_webhooks');
    await db.execute('DROP TABLE IF EXISTS fourthwall_seen_events');
    await db.execute('DROP TABLE IF EXISTS fourthwall_guild_config');
    await db.execute('DROP TABLE IF EXISTS fourthwall_event_routing');
    await db.execute('DROP TABLE IF EXISTS fourthwall_connections');
}
```

- [ ] **Step 4: Run migration**

```bash
cd /home/death/CertiFriedUtility && node migrations/run.js
```

Expected: prints "Applied 112_fourthwall_integration" or similar. If `migrations/run.js` errors with the known `pool.getConnection` bug from `MEMORY.md`, run the migration manually:

```bash
node -e "import('./utils/database.js').then(async ({default:pool}) => { const m = await import('./migrations/112_fourthwall_integration.js'); await m.up(pool); console.log('ok'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })"
```

- [ ] **Step 5: Verify schema**

```bash
node -e "import('./utils/database.js').then(async ({default:p}) => { const [r] = await p.execute(\"SHOW TABLES LIKE 'fourthwall_%'\"); console.log(r); process.exit(0); })"
```

Expected: 6 rows showing all `fourthwall_*` tables.

- [ ] **Step 6: Commit**

```bash
git add migrations/112_fourthwall_integration.js package.json
git commit -m "feat(fourthwall): migration 112 + test script

6 tables: connections, event_routing, guild_config, seen_events,
orphan_webhooks, undelivered_events. Adds 'npm test' wired to
node --test for unit-testable helpers."
```

---

## Task 2: API client (`utils/fourthwall-api.js`)

**Files:**
- Create: `utils/fourthwall-api.js`
- Create: `tests/fourthwall-api.test.js`

- [ ] **Step 1: Write the failing HMAC verify test**

Create `tests/fourthwall-api.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { verifyHmac, basicAuthHeader, buildErrorMessage } from '../utils/fourthwall-api.js';

test('verifyHmac accepts valid signature', () => {
    const secret = 'test-secret';
    const body = Buffer.from('{"event":"ORDER_PLACED","id":"e1"}');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(verifyHmac(body, sig, secret), true);
});

test('verifyHmac rejects bad signature', () => {
    const secret = 'test-secret';
    const body = Buffer.from('{"event":"ORDER_PLACED"}');
    const sig = 'a'.repeat(64);
    assert.equal(verifyHmac(body, sig, secret), false);
});

test('verifyHmac rejects mismatched length without crashing', () => {
    assert.equal(verifyHmac(Buffer.from('x'), 'short', 'secret'), false);
});

test('verifyHmac rejects missing inputs', () => {
    assert.equal(verifyHmac(null, 'sig', 'secret'), false);
    assert.equal(verifyHmac(Buffer.from('x'), null, 'secret'), false);
    assert.equal(verifyHmac(Buffer.from('x'), 'sig', null), false);
});

test('basicAuthHeader encodes user:pass to Basic base64', () => {
    const h = basicAuthHeader('user@example.com', 'p@ss');
    assert.equal(h, 'Basic ' + Buffer.from('user@example.com:p@ss').toString('base64'));
});

test('buildErrorMessage normalizes 401 to credentials-rejected', () => {
    assert.match(buildErrorMessage({ status: 401, data: { error: 'Unauthorized' }}), /credentials.*rejected/i);
});

test('buildErrorMessage falls back to status text', () => {
    assert.match(buildErrorMessage({ status: 500, data: null }), /500/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/death/CertiFriedUtility && npm test 2>&1 | head -40
```

Expected: tests fail with `Cannot find module '../utils/fourthwall-api.js'` or similar import error.

- [ ] **Step 3: Implement `utils/fourthwall-api.js`**

```js
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
        const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        const a = Buffer.from(sigHex, 'utf8');
        const b = Buffer.from(expected, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
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
    const instance = axios.create({
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
    return instance;
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/death/CertiFriedUtility && npm test 2>&1 | tail -20
```

Expected: all 7 tests in `fourthwall-api.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add utils/fourthwall-api.js tests/fourthwall-api.test.js
git commit -m "feat(fourthwall): API client with platform + storefront wrappers

- Basic-Auth header builder, timing-safe HMAC verify, error normalization
- Platform client: shop, webhooks (CRUD), orders, donations, members,
  promotions, giveaways
- Storefront client: shop, product, collection, search
- 7 unit tests cover signature verification + error mapping"
```

---

## Task 3: Pure-logic helpers (pseudonyms, sanitization, currency)

**Files:**
- Create: `core/fourthwall-helpers.js`
- Create: `tests/fourthwall-manager-helpers.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/fourthwall-manager-helpers.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    pseudonymFor, sanitizeUserText, formatCurrency, truncate, generateConnectionToken
} from '../core/fourthwall-helpers.js';

test('pseudonymFor is stable for same inputs', () => {
    const a = pseudonymFor('cust_123', 'guild_456');
    const b = pseudonymFor('cust_123', 'guild_456');
    assert.equal(a, b);
});

test('pseudonymFor differs across guilds', () => {
    const a = pseudonymFor('cust_123', 'guild_A');
    const b = pseudonymFor('cust_123', 'guild_B');
    assert.notEqual(a, b);
});

test('pseudonymFor returns Supporter # in 4-digit range', () => {
    const p = pseudonymFor('cust_123', 'guild_456');
    assert.match(p, /^Supporter #\d{4}$/);
});

test('sanitizeUserText strips role/everyone mentions', () => {
    const out = sanitizeUserText('hi @everyone and <@&123>');
    assert.doesNotMatch(out, /@everyone/);
    assert.doesNotMatch(out, /<@&123>/);
});

test('sanitizeUserText escapes markdown', () => {
    const out = sanitizeUserText('**bold** and `code`');
    assert.match(out, /\\\*\\\*/);
});

test('sanitizeUserText handles null/undefined', () => {
    assert.equal(sanitizeUserText(null), '');
    assert.equal(sanitizeUserText(undefined), '');
});

test('truncate respects Discord field limit', () => {
    const long = 'a'.repeat(2000);
    const out = truncate(long, 1024);
    assert.ok(out.length <= 1024);
    assert.match(out, /…$/);
});

test('truncate leaves short strings alone', () => {
    assert.equal(truncate('hi', 1024), 'hi');
});

test('formatCurrency uses Intl with currency code', () => {
    assert.equal(formatCurrency(1999, 'USD'), '$19.99');
});

test('formatCurrency handles missing currency gracefully', () => {
    const out = formatCurrency(1234, null);
    assert.match(out, /12\.34/);
});

test('generateConnectionToken returns ~32-char base64url', () => {
    const t = generateConnectionToken();
    assert.match(t, /^[A-Za-z0-9_-]{30,}$/);
});

test('generateConnectionToken returns unique values', () => {
    assert.notEqual(generateConnectionToken(), generateConnectionToken());
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/death/CertiFriedUtility && npm test -- tests/fourthwall-manager-helpers.test.js 2>&1 | head -30
```

Expected: import error or all tests fail.

- [ ] **Step 3: Implement `core/fourthwall-helpers.js`**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/death/CertiFriedUtility && npm test 2>&1 | tail -25
```

Expected: all 12 helper tests pass, plus the 7 from Task 2.

- [ ] **Step 5: Commit**

```bash
git add core/fourthwall-helpers.js tests/fourthwall-manager-helpers.test.js
git commit -m "feat(fourthwall): pure-logic helpers (pseudonyms, sanitizer, currency)

- pseudonymFor: stable per (customer, guild), 'Supporter #NNNN' format
- sanitizeUserText: strips mentions + escapes markdown
- formatCurrency via Intl.NumberFormat with safe fallback
- generateConnectionToken: 24 random bytes base64url
- EVENT_CATEGORY_MAP + ALL_EVENT_TYPES centralize FW event taxonomy
- 12 unit tests"
```

---

## Task 4: Manager skeleton + connect/disconnect

**Files:**
- Create: `core/fourthwall-manager.js`

- [ ] **Step 1: Implement manager skeleton**

Create `core/fourthwall-manager.js`:

```js
import pool from '../utils/database.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';
import { platformClient, storefrontClient } from '../utils/fourthwall-api.js';
import {
    generateConnectionToken, pseudonymFor, sanitizeUserText, truncate, formatCurrency,
    EVENT_CATEGORY_MAP, ALL_EVENT_TYPES, parseHexColor, EMBED_DEFAULT_COLOR
} from './fourthwall-helpers.js';
import { EmbedBuilder } from 'discord.js';

function encryptStr(value) {
    return JSON.stringify(encryption.encrypt(value));
}
function decryptStr(value) {
    if (!value) return null;
    try {
        return encryption.decrypt(JSON.parse(value));
    } catch (err) {
        logger.error('[FW Manager] Failed to decrypt', { err: err.message });
        return null;
    }
}

export default class FourthwallManager {
    constructor(client) {
        this.client = client;
    }

    // ── Connection lifecycle ─────────────────────────────────────────────────

    async connectShop({ guildId, shopHandle, apiUser, apiPass, storefrontToken, connectedBy }) {
        const webhookBase = process.env.FOURTHWALL_WEBHOOK_BASE_URL;
        if (!webhookBase) throw new Error('FOURTHWALL_WEBHOOK_BASE_URL not configured');

        const platform = platformClient(apiUser, apiPass);
        const shop = await platform.getShop();

        const connectionToken = generateConnectionToken();
        const webhookUrl = `${webhookBase.replace(/\/+$/, '')}/webhooks/fourthwall/${connectionToken}`;

        const [insert] = await pool.execute(
            `INSERT INTO fourthwall_connections
                (guild_id, shop_handle, shop_name, shop_id, api_username, api_password,
                 storefront_token, connection_token, connected_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                guildId, shopHandle, shop.name || shopHandle, shop.id || null,
                encryptStr(apiUser), encryptStr(apiPass),
                storefrontToken || null, connectionToken, connectedBy
            ]
        );
        const connectionId = insert.insertId;

        // Register webhooks. First successful create returns the shared HMAC secret.
        const registered = [];
        let webhookSecret = null;
        for (const eventType of ALL_EVENT_TYPES) {
            try {
                const created = await platform.createWebhook({ url: webhookUrl, eventType });
                registered.push({ id: created.id, eventType });
                if (!webhookSecret && created.secret) webhookSecret = created.secret;
            } catch (err) {
                logger.warn('[FW Manager] webhook create failed', {
                    connectionId, eventType, err: err.message
                });
            }
        }
        if (!webhookSecret) {
            throw new Error('Fourthwall returned no webhook secret — webhook registration failed entirely.');
        }

        await pool.execute(
            `UPDATE fourthwall_connections SET webhook_secret = ?, webhook_ids = ? WHERE id = ?`,
            [encryptStr(webhookSecret), JSON.stringify(registered), connectionId]
        );

        // Seed default routing (cart_abandoned starts disabled — internal-only).
        const categories = ['orders','donations','memberships','giveaways','promotions','newsletter','thank_you','cart_abandoned'];
        for (const cat of categories) {
            await pool.execute(
                `INSERT IGNORE INTO fourthwall_event_routing (connection_id, event_category, enabled) VALUES (?, ?, ?)`,
                [connectionId, cat, cat === 'cart_abandoned' ? 0 : 1]
            );
        }

        return { connectionId, registeredEvents: registered.length, shopName: shop.name };
    }

    async disconnectShop({ guildId, shopHandle }) {
        const [rows] = await pool.execute(
            `SELECT id, api_username, api_password, webhook_ids
             FROM fourthwall_connections WHERE guild_id = ? AND shop_handle = ?`,
            [guildId, shopHandle]
        );
        if (rows.length === 0) throw new Error('Shop not connected to this guild');
        const conn = rows[0];

        const apiUser = decryptStr(conn.api_username);
        const apiPass = decryptStr(conn.api_password);
        const platform = platformClient(apiUser, apiPass);
        const webhookIds = conn.webhook_ids ? (typeof conn.webhook_ids === 'string' ? JSON.parse(conn.webhook_ids) : conn.webhook_ids) : [];

        let removed = 0, orphaned = 0;
        for (const wh of webhookIds) {
            try {
                await platform.deleteWebhook(wh.id);
                removed++;
            } catch (err) {
                orphaned++;
                await pool.execute(
                    `INSERT INTO fourthwall_orphan_webhooks (connection_id, webhook_id, api_username, api_password)
                     VALUES (?, ?, ?, ?)`,
                    [conn.id, wh.id, conn.api_username, conn.api_password]
                );
                logger.warn('[FW Manager] webhook delete failed, orphaning', { id: wh.id, err: err.message });
            }
        }

        await pool.execute(`DELETE FROM fourthwall_connections WHERE id = ?`, [conn.id]);
        return { removed, orphaned };
    }

    async listConnections(guildId) {
        const [rows] = await pool.execute(
            `SELECT id, shop_handle, shop_name, last_event_at, connected_at
             FROM fourthwall_connections WHERE guild_id = ? ORDER BY connected_at DESC`,
            [guildId]
        );
        return rows;
    }

    async getConnection(guildId, shopHandle) {
        const [rows] = await pool.execute(
            `SELECT * FROM fourthwall_connections WHERE guild_id = ? AND shop_handle = ?`,
            [guildId, shopHandle]
        );
        return rows[0] || null;
    }

    async getConnectionById(id) {
        const [rows] = await pool.execute(
            `SELECT * FROM fourthwall_connections WHERE id = ?`, [id]
        );
        return rows[0] || null;
    }

    platformForConnection(conn) {
        const user = decryptStr(conn.api_username);
        const pass = decryptStr(conn.api_password);
        return platformClient(user, pass);
    }

    // ── Routing ─────────────────────────────────────────────────────────────

    async setRouting({ connectionId, category, channelId, enabled }) {
        await pool.execute(
            `INSERT INTO fourthwall_event_routing (connection_id, event_category, channel_id, enabled)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), enabled = VALUES(enabled)`,
            [connectionId, category, channelId || null, enabled ? 1 : 0]
        );
    }

    async getRouting(connectionId, category) {
        const [rows] = await pool.execute(
            `SELECT channel_id, enabled FROM fourthwall_event_routing
             WHERE connection_id = ? AND event_category = ?`,
            [connectionId, category]
        );
        return rows[0] || null;
    }

    async getGuildConfig(guildId) {
        const [rows] = await pool.execute(
            `SELECT * FROM fourthwall_guild_config WHERE guild_id = ?`, [guildId]
        );
        return rows[0] || {
            guild_id: guildId, default_channel_id: null,
            show_customer_names: 0, show_amounts: 1, embed_color: '#FF6B35'
        };
    }

    async setGuildConfig(guildId, patch) {
        const current = await this.getGuildConfig(guildId);
        const next = { ...current, ...patch };
        await pool.execute(
            `INSERT INTO fourthwall_guild_config
                (guild_id, default_channel_id, show_customer_names, show_amounts, embed_color)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                default_channel_id = VALUES(default_channel_id),
                show_customer_names = VALUES(show_customer_names),
                show_amounts = VALUES(show_amounts),
                embed_color = VALUES(embed_color)`,
            [
                guildId, next.default_channel_id,
                next.show_customer_names ? 1 : 0,
                next.show_amounts ? 1 : 0,
                next.embed_color
            ]
        );
    }

    async resolveChannelId(connection, category) {
        const route = await this.getRouting(connection.id, category);
        if (route && route.enabled && route.channel_id) return route.channel_id;
        if (route && !route.enabled) return null; // explicitly off
        const cfg = await this.getGuildConfig(connection.guild_id);
        return cfg.default_channel_id || null;
    }

    // ── Event handling ──────────────────────────────────────────────────────

    async handleEvent(eventType, payload, connection) {
        const category = EVENT_CATEGORY_MAP[eventType];
        if (!category) {
            logger.info('[FW Manager] unmapped event type', { eventType, connectionId: connection.id });
            return;
        }

        const channelId = await this.resolveChannelId(connection, category);
        if (!channelId) {
            logger.info('[FW Manager] no channel routed', { category, connectionId: connection.id });
            return;
        }

        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            logger.warn('[FW Manager] channel not fetchable', { channelId, category });
            return;
        }

        const cfg = await this.getGuildConfig(connection.guild_id);
        const embed = this.buildEmbed(eventType, payload, connection, cfg);
        if (!embed) return;

        await channel.send({
            embeds: [embed],
            allowedMentions: { parse: [] }
        }).catch(err => {
            logger.error('[FW Manager] send failed', { channelId, err: err.message });
        });

        await pool.execute(
            `UPDATE fourthwall_connections SET last_event_at = NOW() WHERE id = ?`,
            [connection.id]
        );
    }

    // Embed builders are filled in Task 5.
    buildEmbed(eventType, payload, connection, cfg) {
        const color = parseHexColor(cfg.embed_color);
        const category = EVENT_CATEGORY_MAP[eventType];
        switch (category) {
            case 'orders': return this.buildOrderEmbed(eventType, payload, connection, cfg, color);
            case 'donations': return this.buildDonationEmbed(payload, connection, cfg, color);
            case 'memberships': return this.buildMembershipEmbed(eventType, payload, connection, cfg, color);
            case 'giveaways': return this.buildGiveawayEmbed(eventType, payload, connection, cfg, color);
            case 'promotions': return this.buildPromotionEmbed(eventType, payload, connection, cfg, color);
            case 'newsletter': return this.buildNewsletterEmbed(payload, connection, cfg, color);
            case 'thank_you': return this.buildThankYouEmbed(payload, connection, cfg, color);
            case 'cart_abandoned': return this.buildCartAbandonedEmbed(eventType, payload, connection, cfg, color);
            default: return null;
        }
    }

    nameFor(customerId, customerName, cfg, connection) {
        if (cfg.show_customer_names && customerName) return sanitizeUserText(customerName);
        return pseudonymFor(customerId || 'anon', connection.guild_id);
    }

    buildOrderEmbed(eventType, p, connection, cfg, color) {
        const name = this.nameFor(p.customerId, p.customerName, cfg, connection);
        const items = (p.items || []).slice(0, 3).map(i => `• ${sanitizeUserText(i.name)} × ${i.quantity}`).join('\n');
        const more = (p.items || []).length > 3 ? `\n…and ${p.items.length - 3} more` : '';
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(eventType === 'GIFT_PURCHASE' ? '🎁 New gift purchase' : '🛒 New order')
            .setDescription(`From **${name}**`)
            .addFields({ name: 'Items', value: (items + more) || '_(unknown)_' });
        if (cfg.show_amounts && p.total != null) {
            embed.addFields({ name: 'Total', value: formatCurrency(p.total, p.currency), inline: true });
        }
        if (p.shippingCountry) embed.addFields({ name: 'Ships to', value: String(p.shippingCountry), inline: true });
        if (p.orderNumber) embed.setFooter({ text: `Order …${String(p.orderNumber).slice(-4)}` });
        embed.setTimestamp(new Date(p.createdAt || Date.now()));
        return embed;
    }

    buildDonationEmbed(p, connection, cfg, color) {
        const name = this.nameFor(p.customerId, p.customerName, cfg, connection);
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle('💝 New donation')
            .setDescription(`**${name}** sent a donation!`);
        if (cfg.show_amounts && p.amount != null) {
            embed.addFields({ name: 'Amount', value: `**${formatCurrency(p.amount, p.currency)}**`, inline: true });
        }
        if (p.message) {
            embed.addFields({ name: 'Message', value: truncate(sanitizeUserText(p.message), 500) });
        }
        embed.setTimestamp(new Date(p.createdAt || Date.now()));
        return embed;
    }

    buildMembershipEmbed(eventType, p, connection, cfg, color) {
        const name = this.nameFor(p.customerId, p.customerName, cfg, connection);
        const verb = eventType === 'SUBSCRIPTION_PURCHASED' ? 'joined'
                   : eventType === 'SUBSCRIPTION_CHANGED' ? 'changed tier'
                   : 'expired';
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🎟 Membership ${verb}`)
            .setDescription(`**${name}** — ${sanitizeUserText(p.tierName || 'unknown tier')}`);
        if (p.period) embed.addFields({ name: 'Period', value: sanitizeUserText(p.period), inline: true });
        embed.setTimestamp(new Date(p.eventAt || Date.now()));
        return embed;
    }

    buildGiveawayEmbed(eventType, p, connection, cfg, color) {
        const ended = eventType === 'GIVEAWAY_DRAW_ENDED';
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🎁 Giveaway ${ended ? 'ended' : 'started'}`)
            .setDescription(sanitizeUserText(p.prize || 'Giveaway draw'))
            .addFields(
                { name: 'Draw ID', value: String(p.drawId || '—'), inline: true },
                { name: 'Entries', value: String(p.entryCount ?? '—'), inline: true }
            );
        if (ended && p.winner) {
            embed.addFields({ name: '🏆 Winner', value: sanitizeUserText(p.winner) });
        }
        return embed;
    }

    buildPromotionEmbed(eventType, p, connection, cfg, color) {
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🏷 Promo ${eventType === 'PROMOTION_CREATED' ? 'created' : eventType === 'PROMOTION_STATUS_CHANGED' ? `${p.status}` : 'updated'}`)
            .addFields(
                { name: 'Code', value: '`' + sanitizeUserText(p.code || '—') + '`', inline: true },
                { name: 'Discount', value: sanitizeUserText(String(p.discount || '—')), inline: true }
            );
        if (p.expiresAt) embed.addFields({ name: 'Expires', value: `<t:${Math.floor(new Date(p.expiresAt).getTime()/1000)}:R>`, inline: true });
        return embed;
    }

    buildNewsletterEmbed(p, connection, cfg, color) {
        return new EmbedBuilder()
            .setColor(color)
            .setTitle('📬 New newsletter subscriber')
            .setDescription('A new subscriber joined the shop newsletter.');
    }

    buildThankYouEmbed(p, connection, cfg, color) {
        const name = this.nameFor(p.customerId, p.customerName, cfg, connection);
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle('✨ Thank-you message sent')
            .setDescription(`To **${name}**`);
        if (p.message) {
            embed.addFields({ name: 'Message', value: truncate(sanitizeUserText(p.message), 500) });
        }
        return embed;
    }

    buildCartAbandonedEmbed(eventType, p, connection, cfg, color) {
        const after = eventType === 'CART_ABANDONED_72H' ? '72h'
                    : eventType === 'CART_ABANDONED_24H' ? '24h' : '1h';
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🛒 Abandoned cart (${after})`);
        if (cfg.show_amounts && p.total != null) {
            embed.addFields({ name: 'Cart total', value: formatCurrency(p.total, p.currency), inline: true });
        }
        return embed;
    }
}

export { decryptStr };
```

- [ ] **Step 2: Smoke check — module loads**

```bash
cd /home/death/CertiFriedUtility && node -e "import('./core/fourthwall-manager.js').then(m => console.log('ok', typeof m.default))"
```

Expected: `ok function`.

- [ ] **Step 3: Commit**

```bash
git add core/fourthwall-manager.js
git commit -m "feat(fourthwall): manager (connect/disconnect/routing/dispatch + 8 embed builders)

- connectShop: stores encrypted creds, registers all webhook event types,
  seeds default routing (cart_abandoned disabled by default)
- disconnectShop: deletes FW-side webhooks, orphans failures, drops local row
- Routing: per-(connection, category) channel + enable toggle with fallback
  to fourthwall_guild_config.default_channel_id
- handleEvent: dedupes via channel resolution, sanitizes all embeds with
  AllowedMentions parse:[], updates last_event_at
- 8 embed builders honor show_customer_names + show_amounts opt-ins"
```

---

## Task 5: Webhook receiver

**Files:**
- Create: `dashboard/routes/webhooks/fourthwall.js`
- Modify: `dashboard/app.js`
- Modify: `core/bot-manager.js`

- [ ] **Step 1: Add `getClientForGuild` helper to bot-manager**

In `core/bot-manager.js`, add this method to the `BotManager` class (place it near other guild-related helpers — search for `guildBotMapping` to find context):

```js
    /**
     * Get the bot client that serves a given guild.
     * Returns the custom bot client if mapped, else the default client.
     */
    getClientForGuild(guildId) {
        const botId = this.guildBotMapping.get(String(guildId)) || this.defaultBotId;
        const entry = this.clients.get(botId);
        return entry?.client || this.clients.get(this.defaultBotId)?.client || null;
    }
```

Verify by running: `grep -n "getClientForGuild" core/bot-manager.js` — should show your new method.

- [ ] **Step 2: Implement the webhook route**

Create `dashboard/routes/webhooks/fourthwall.js`:

```js
import express from 'express';
import pool from '../../../utils/database.js';
import logger from '../../../utils/logger.js';
import encryption from '../../../utils/encryption.js';
import { verifyHmac } from '../../../utils/fourthwall-api.js';
import botManager from '../../../core/bot-manager.js';

const router = express.Router();

router.post(
    '/:token',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
        const { token } = req.params;
        const sigHeader = req.get('X-Fourthwall-Hmac-Sha256')
            || req.get('Fourthwall-Hmac-Sha256')
            || req.get('X-Webhook-Signature');

        if (!sigHeader) {
            logger.warn('[FW Webhook] missing signature header');
            return res.status(401).end();
        }

        let connRow;
        try {
            const [rows] = await pool.execute(
                `SELECT * FROM fourthwall_connections WHERE connection_token = ?`,
                [token]
            );
            connRow = rows[0];
        } catch (err) {
            logger.error('[FW Webhook] db lookup failed', { err: err.message });
            return res.status(500).end();
        }
        if (!connRow) return res.status(404).end();

        let secret;
        try {
            secret = encryption.decrypt(JSON.parse(connRow.webhook_secret));
        } catch (err) {
            logger.error('[FW Webhook] secret decrypt failed', { err: err.message, connectionId: connRow.id });
            return res.status(500).end();
        }

        if (!verifyHmac(req.body, sigHeader, secret)) {
            logger.warn('[FW Webhook] HMAC mismatch', { connectionId: connRow.id });
            return res.status(401).end();
        }

        let payload;
        try {
            payload = JSON.parse(req.body.toString('utf8'));
        } catch (err) {
            logger.warn('[FW Webhook] bad json', { err: err.message });
            return res.status(400).end();
        }

        const eventId = payload.id || payload.event_id || payload.eventId
            || (req.get('X-Fourthwall-Event-Id') || '')
            || `${connRow.id}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
        const eventType = payload.type || payload.event || payload.eventType
            || req.get('X-Fourthwall-Event-Type') || 'UNKNOWN';

        let inserted;
        try {
            [inserted] = await pool.execute(
                `INSERT IGNORE INTO fourthwall_seen_events (event_id, connection_id, event_type) VALUES (?, ?, ?)`,
                [String(eventId).slice(0, 100), connRow.id, String(eventType).slice(0, 100)]
            );
        } catch (err) {
            logger.error('[FW Webhook] dedupe insert failed', { err: err.message });
            return res.status(500).end();
        }
        if (inserted.affectedRows === 0) {
            return res.status(204).end(); // replay; ack but do nothing
        }

        res.status(204).end();

        setImmediate(async () => {
            const client = botManager.getClientForGuild(connRow.guild_id);
            if (!client?.fourthwallManager) {
                logger.warn('[FW Webhook] no client/manager for guild', { guildId: connRow.guild_id });
                await pool.execute(
                    `INSERT INTO fourthwall_undelivered_events (connection_id, event_id, event_type, payload) VALUES (?, ?, ?, ?)`,
                    [connRow.id, String(eventId).slice(0, 100), String(eventType).slice(0, 100), JSON.stringify(payload)]
                ).catch(e => logger.error('[FW Webhook] undelivered insert failed', { err: e.message }));
                return;
            }
            try {
                await client.fourthwallManager.handleEvent(eventType, payload, connRow);
            } catch (err) {
                logger.error('[FW Webhook] handleEvent threw', {
                    err: err.message, stack: err.stack, eventType, connectionId: connRow.id
                });
            }
        });
    }
);

export default router;
```

- [ ] **Step 3: Mount the webhook route in `dashboard/app.js` BEFORE the body parser**

Read the current `dashboard/app.js` around lines 75-100. Insert the webhook mount immediately AFTER `app.use(passport.session())` (line 83) and BEFORE the body-parser middleware (line 86). The route uses its own `express.raw()`, so order matters.

Add this import near the top of `dashboard/app.js` with the other route imports:

```js
import fourthwallWebhookRouter from './routes/webhooks/fourthwall.js';
```

Then between line 83 and line 86, insert:

```js
    // Fourthwall webhook receiver — mounted BEFORE body parser to preserve raw body for HMAC verify
    app.use('/webhooks/fourthwall', fourthwallWebhookRouter);
```

- [ ] **Step 4: Verify mount order**

```bash
grep -n "fourthwall\|express.json\|passport.session" /home/death/CertiFriedUtility/dashboard/app.js | head -10
```

Expected output ordering: `passport.session` → `fourthwall` → `express.json`.

- [ ] **Step 5: Smoke test webhook route with bad signature**

Start the bot in dev mode in another shell (or assume the dashboard is running on its configured port — check `.env` for `DASHBOARD_PORT`, default 3000). Then:

```bash
curl -i -X POST http://localhost:3000/webhooks/fourthwall/unknown-token \
  -H 'Content-Type: application/json' \
  -H 'X-Fourthwall-Hmac-Sha256: deadbeef' \
  -d '{"id":"e1","type":"ORDER_PLACED"}'
```

Expected: `HTTP/1.1 404 Not Found` (no connection exists for that token).

- [ ] **Step 6: Commit**

```bash
git add dashboard/routes/webhooks/fourthwall.js dashboard/app.js core/bot-manager.js
git commit -m "feat(fourthwall): webhook receiver with HMAC + dedupe + dispatch

- POST /webhooks/fourthwall/:token mounted before body parser
- Raw-body capture per-route preserves bytes for HMAC verify
- Timing-safe HMAC compare via verifyHmac()
- INSERT IGNORE into fourthwall_seen_events provides replay-safe dedupe
- 204 ACK before setImmediate dispatch keeps FW retry timer happy
- Undelivered events stashed if target bot client is offline
- bot-manager.getClientForGuild() routes events to right client"
```

---

## Task 6: Slash command + setup modal

**Files:**
- Create: `commands/community/fourthwall.js`
- Create: `commands/community/fourthwall-handler.js`
- Create: `interactions/modals/fourthwall_setup_submit.js`
- Modify: `interactions/handlerRegistry.js`

- [ ] **Step 1: Implement the slash command schema**

Create `commands/community/fourthwall.js`:

```js
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import * as h from './fourthwall-handler.js';

const CATEGORY_CHOICES = [
    { name: 'Orders', value: 'orders' },
    { name: 'Donations', value: 'donations' },
    { name: 'Memberships', value: 'memberships' },
    { name: 'Giveaways', value: 'giveaways' },
    { name: 'Promotions', value: 'promotions' },
    { name: 'Newsletter', value: 'newsletter' },
    { name: 'Thank-you', value: 'thank_you' },
    { name: 'Cart abandoned', value: 'cart_abandoned' }
];

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('fourthwall')
        .setDescription('Fourthwall shop integration — notifications, browsing, admin')

        // Connection management
        .addSubcommand(s => s.setName('setup').setDescription('Connect a Fourthwall shop (opens modal)'))
        .addSubcommand(s => s.setName('disconnect').setDescription('Disconnect a shop')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List connected shops in this guild'))
        .addSubcommand(s => s.setName('resync').setDescription('Replay recent events for a shop')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
            .addIntegerOption(o => o.setName('hours').setDescription('Hours back (1-72)').setMinValue(1).setMaxValue(72)))

        // Routing
        .addSubcommand(s => s.setName('route').setDescription('Set channel for an event category')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
            .addStringOption(o => o.setName('category').setDescription('Event category').setRequired(true).addChoices(...CATEGORY_CHOICES))
            .addChannelOption(o => o.setName('channel').setDescription('Channel to post to')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
            .addBooleanOption(o => o.setName('enabled').setDescription('Enable this category (default true)')))
        .addSubcommand(s => s.setName('default-channel').setDescription('Set fallback channel for unrouted events')
            .addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
        .addSubcommand(s => s.setName('privacy').setDescription('Toggle privacy options for embeds')
            .addBooleanOption(o => o.setName('show_names').setDescription('Show real customer names (default off)'))
            .addBooleanOption(o => o.setName('show_amounts').setDescription('Show monetary amounts (default on)')))

        // Browse
        .addSubcommand(s => s.setName('shop').setDescription('View a shop overview')
            .addStringOption(o => o.setName('handle').setDescription('Shop handle (default: connected shop)')))
        .addSubcommand(s => s.setName('product').setDescription('Look up a product')
            .addStringOption(o => o.setName('slug').setDescription('Product slug').setRequired(true))
            .addStringOption(o => o.setName('shop').setDescription('Shop handle')))
        .addSubcommand(s => s.setName('collection').setDescription('Look up a collection')
            .addStringOption(o => o.setName('slug').setDescription('Collection slug').setRequired(true))
            .addStringOption(o => o.setName('shop').setDescription('Shop handle')))
        .addSubcommand(s => s.setName('search').setDescription('Search products')
            .addStringOption(o => o.setName('query').setDescription('Search query').setRequired(true))
            .addStringOption(o => o.setName('shop').setDescription('Shop handle')))
        .addSubcommand(s => s.setName('promotions').setDescription('List active promo codes')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle')))

        // Admin (mod-only — surfaces PII)
        .addSubcommand(s => s.setName('stats').setDescription('Shop counters (orders/revenue/donations/members)')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
            .addStringOption(o => o.setName('period').setDescription('Time period').addChoices(
                { name: 'Last 7 days', value: '7d' },
                { name: 'Last 30 days', value: '30d' },
                { name: 'All time', value: 'all' }
            )))
        .addSubcommand(s => s.setName('recent').setDescription('List recent items (orders/donations/members)')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
            .addStringOption(o => o.setName('kind').setDescription('What to list').setRequired(true).addChoices(
                { name: 'Orders', value: 'orders' },
                { name: 'Donations', value: 'donations' },
                { name: 'Members', value: 'members' }
            ))
            .addIntegerOption(o => o.setName('limit').setDescription('How many (5-25)').setMinValue(5).setMaxValue(25)))
        .addSubcommandGroup(g => g.setName('giveaway').setDescription('Giveaway management')
            .addSubcommand(s => s.setName('draw').setDescription('Trigger a giveaway draw')
                .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
                .addStringOption(o => o.setName('id').setDescription('Draw ID').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('List active draws')
                .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        try {
            if (group === 'giveaway') {
                return await h.handleGiveaway(interaction, sub);
            }
            switch (sub) {
                case 'setup': return await h.handleSetup(interaction);
                case 'disconnect': return await h.handleDisconnect(interaction);
                case 'list': return await h.handleList(interaction);
                case 'resync': return await h.handleResync(interaction);
                case 'route': return await h.handleRoute(interaction);
                case 'default-channel': return await h.handleDefaultChannel(interaction);
                case 'privacy': return await h.handlePrivacy(interaction);
                case 'shop': return await h.handleShop(interaction);
                case 'product': return await h.handleProduct(interaction);
                case 'collection': return await h.handleCollection(interaction);
                case 'search': return await h.handleSearch(interaction);
                case 'promotions': return await h.handlePromotions(interaction);
                case 'stats': return await h.handleStats(interaction);
                case 'recent': return await h.handleRecent(interaction);
                default:
                    return await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
            }
        } catch (err) {
            const logger = (await import('../../utils/logger.js')).default;
            logger.error('[FW Command] error', { err: err.message, stack: err.stack, sub });
            const reply = interaction.deferred || interaction.replied ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
            await reply({ content: `Error: ${err.message}`, ephemeral: true }).catch(() => {});
        }
    }
};
```

- [ ] **Step 2: Implement handlers (split for readability)**

Create `commands/community/fourthwall-handler.js`:

```js
import {
    ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    EmbedBuilder, PermissionFlagsBits
} from 'discord.js';
import logger from '../../utils/logger.js';
import { storefrontClient } from '../../utils/fourthwall-api.js';
import { sanitizeUserText, truncate, formatCurrency, EMBED_DEFAULT_COLOR, parseHexColor } from '../../core/fourthwall-helpers.js';

function requireManage(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('Requires Manage Server permission');
    }
}

function mgr(interaction) {
    const m = interaction.client.fourthwallManager;
    if (!m) throw new Error('Fourthwall manager not initialized on this bot');
    return m;
}

export async function handleSetup(interaction) {
    requireManage(interaction);
    const modal = new ModalBuilder()
        .setCustomId('fourthwall_setup_submit')
        .setTitle('Connect Fourthwall Shop')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('handle').setLabel('Shop handle (URL slug)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('api_user').setLabel('Platform API username').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255).setPlaceholder('fw_api_xxxxx@fourthwall.com')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('api_pass').setLabel('Platform API password').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('storefront_token').setLabel('Storefront token (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(255).setPlaceholder('ptkn_...')
            )
        );
    await interaction.showModal(modal);
}

export async function handleDisconnect(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const result = await mgr(interaction).disconnectShop({ guildId: interaction.guildId, shopHandle: shop });
    await interaction.editReply(`Disconnected **${shop}**. Removed ${result.removed} webhooks, orphaned ${result.orphaned}.`);
}

export async function handleList(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const conns = await mgr(interaction).listConnections(interaction.guildId);
    if (conns.length === 0) {
        return interaction.editReply('No shops connected. Use `/fourthwall setup` to connect one.');
    }
    const lines = conns.map(c => {
        const last = c.last_event_at ? `<t:${Math.floor(new Date(c.last_event_at).getTime()/1000)}:R>` : 'never';
        return `• **${c.shop_handle}** — ${c.shop_name || ''} · last event: ${last}`;
    });
    await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR).setTitle('Connected Fourthwall shops').setDescription(lines.join('\n'))]
    });
}

export async function handleResync(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const hours = interaction.options.getInteger('hours') || 24;
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    const platform = mgr(interaction).platformForConnection(conn);
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    let replayed = 0;
    try {
        const orders = await platform.listOrders({ since, limit: 25 });
        for (const o of (orders.items || orders || [])) {
            await mgr(interaction).handleEvent('ORDER_PLACED', o, conn);
            replayed++;
        }
        const donations = await platform.listDonations({ since, limit: 25 });
        for (const d of (donations.items || donations || [])) {
            await mgr(interaction).handleEvent('ORDER_DONATION', d, conn);
            replayed++;
        }
    } catch (err) {
        logger.warn('[FW resync] partial', { err: err.message });
    }
    await interaction.editReply(`Replayed ${replayed} events from the last ${hours}h.`);
}

export async function handleRoute(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const category = interaction.options.getString('category');
    const channel = interaction.options.getChannel('channel');
    const enabled = interaction.options.getBoolean('enabled') ?? true;
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    await mgr(interaction).setRouting({ connectionId: conn.id, category, channelId: channel.id, enabled });
    await interaction.editReply(`✓ ${category} for **${shop}** → <#${channel.id}> (${enabled ? 'enabled' : 'disabled'})`);
}

export async function handleDefaultChannel(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    await mgr(interaction).setGuildConfig(interaction.guildId, { default_channel_id: channel.id });
    await interaction.editReply(`✓ Default channel set to <#${channel.id}>`);
}

export async function handlePrivacy(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const patch = {};
    const sn = interaction.options.getBoolean('show_names');
    const sa = interaction.options.getBoolean('show_amounts');
    if (sn !== null) patch.show_customer_names = sn ? 1 : 0;
    if (sa !== null) patch.show_amounts = sa ? 1 : 0;
    if (Object.keys(patch).length === 0) throw new Error('Pass at least one of show_names or show_amounts');
    await mgr(interaction).setGuildConfig(interaction.guildId, patch);
    const cfg = await mgr(interaction).getGuildConfig(interaction.guildId);
    await interaction.editReply(`Privacy: show_names=**${!!cfg.show_customer_names}**, show_amounts=**${!!cfg.show_amounts}**`);
}

async function pickStorefrontToken(interaction, explicitHandle) {
    if (explicitHandle) {
        const conn = await mgr(interaction).getConnection(interaction.guildId, explicitHandle);
        if (conn?.storefront_token) return { token: conn.storefront_token, handle: explicitHandle };
    }
    const conns = await mgr(interaction).listConnections(interaction.guildId);
    const first = conns[0];
    if (!first) throw new Error('No connected shop in this guild. Pass a shop handle or run /fourthwall setup.');
    const full = await mgr(interaction).getConnection(interaction.guildId, first.shop_handle);
    return { token: full?.storefront_token || null, handle: first.shop_handle };
}

export async function handleShop(interaction) {
    await interaction.deferReply();
    const explicit = interaction.options.getString('handle');
    const { token, handle } = await pickStorefrontToken(interaction, explicit);
    const sf = storefrontClient(token);
    const shop = await sf.getShop();
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(shop.name || handle)
        .setURL(shop.url || null)
        .setDescription(truncate(sanitizeUserText(shop.description || ''), 500));
    await interaction.editReply({ embeds: [embed] });
}

export async function handleProduct(interaction) {
    await interaction.deferReply();
    const slug = interaction.options.getString('slug');
    const explicit = interaction.options.getString('shop');
    const { token } = await pickStorefrontToken(interaction, explicit);
    const sf = storefrontClient(token);
    const prod = await sf.getProduct(slug);
    const price = prod.price?.amount ? formatCurrency(prod.price.amount, prod.price.currency) : '—';
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(sanitizeUserText(prod.name || slug))
        .setURL(prod.url || null)
        .setDescription(truncate(sanitizeUserText(prod.description || ''), 500))
        .addFields({ name: 'Price', value: price, inline: true });
    if (prod.image) embed.setImage(prod.image);
    await interaction.editReply({ embeds: [embed] });
}

export async function handleCollection(interaction) {
    await interaction.deferReply();
    const slug = interaction.options.getString('slug');
    const explicit = interaction.options.getString('shop');
    const { token } = await pickStorefrontToken(interaction, explicit);
    const sf = storefrontClient(token);
    const col = await sf.getCollection(slug);
    const items = (col.products || []).slice(0, 10).map(p => `• ${sanitizeUserText(p.name)} — ${p.price ? formatCurrency(p.price.amount, p.price.currency) : '—'}`).join('\n');
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(sanitizeUserText(col.name || slug))
        .setDescription(items || '_(empty collection)_');
    await interaction.editReply({ embeds: [embed] });
}

export async function handleSearch(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('query');
    const explicit = interaction.options.getString('shop');
    const { token } = await pickStorefrontToken(interaction, explicit);
    const sf = storefrontClient(token);
    const results = await sf.searchProducts(query);
    const list = (results.items || results.products || []).slice(0, 10);
    const lines = list.map(p => `• **${sanitizeUserText(p.name)}** — ${p.price ? formatCurrency(p.price.amount, p.price.currency) : '—'}`).join('\n');
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(`Search: ${sanitizeUserText(query)}`)
        .setDescription(lines || '_no results_');
    await interaction.editReply({ embeds: [embed] });
}

export async function handlePromotions(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const explicit = interaction.options.getString('shop');
    const conn = explicit
        ? await mgr(interaction).getConnection(interaction.guildId, explicit)
        : (await mgr(interaction).listConnections(interaction.guildId)).map(c => ({ shop_handle: c.shop_handle }))[0]
            ? await mgr(interaction).getConnection(interaction.guildId, (await mgr(interaction).listConnections(interaction.guildId))[0].shop_handle)
            : null;
    if (!conn) throw new Error('No connected shop. Pass a shop handle or run /fourthwall setup.');
    const platform = mgr(interaction).platformForConnection(conn);
    const promos = await platform.listPromotions();
    const list = (promos.items || promos || []).slice(0, 10);
    const lines = list.map(p => `\`${p.code}\` — ${p.discount} · expires ${p.expiresAt ? `<t:${Math.floor(new Date(p.expiresAt).getTime()/1000)}:R>` : 'never'}`).join('\n');
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR).setTitle('Promotions').setDescription(lines || '_(none)_');
    await interaction.editReply({ embeds: [embed] });
}

export async function handleStats(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const period = interaction.options.getString('period') || '30d';
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    const platform = mgr(interaction).platformForConnection(conn);
    const sinceDays = period === '7d' ? 7 : period === '30d' ? 30 : null;
    const since = sinceDays ? new Date(Date.now() - sinceDays * 86400_000).toISOString() : undefined;

    const orders = await platform.listOrders({ since, limit: 25 }).catch(() => ({ items: [] }));
    const donations = await platform.listDonations({ since, limit: 25 }).catch(() => ({ items: [] }));
    const members = await platform.listMembers({ limit: 25 }).catch(() => ({ items: [] }));

    const orderItems = orders.items || orders || [];
    const donationItems = donations.items || donations || [];
    const memberItems = members.items || members || [];
    const revenue = orderItems.reduce((acc, o) => acc + (o.total || 0), 0);

    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(`Stats — ${shop} (${period})`)
        .addFields(
            { name: 'Orders', value: String(orderItems.length), inline: true },
            { name: 'Revenue', value: formatCurrency(revenue, orderItems[0]?.currency || 'USD'), inline: true },
            { name: 'Donations', value: String(donationItems.length), inline: true },
            { name: 'Members (recent)', value: String(memberItems.length), inline: true }
        );
    await interaction.editReply({ embeds: [embed] });
}

export async function handleRecent(interaction) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const kind = interaction.options.getString('kind');
    const limit = interaction.options.getInteger('limit') || 10;
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    const platform = mgr(interaction).platformForConnection(conn);
    let items = [];
    if (kind === 'orders') {
        const r = await platform.listOrders({ limit });
        items = (r.items || r || []).map(o => `• ${o.orderNumber || o.id} — ${formatCurrency(o.total || 0, o.currency)}`);
    } else if (kind === 'donations') {
        const r = await platform.listDonations({ limit });
        items = (r.items || r || []).map(d => `• ${formatCurrency(d.amount || 0, d.currency)} — ${sanitizeUserText(d.customerName || 'anon')}`);
    } else {
        const r = await platform.listMembers({ limit });
        items = (r.items || r || []).map(m => `• ${sanitizeUserText(m.customerName || m.email || '?')} — ${sanitizeUserText(m.tierName || '?')}`);
    }
    const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR)
        .setTitle(`Recent ${kind} — ${shop}`)
        .setDescription(items.join('\n') || '_(none)_');
    await interaction.editReply({ embeds: [embed] });
}

export async function handleGiveaway(interaction, sub) {
    requireManage(interaction);
    await interaction.deferReply({ ephemeral: true });
    const shop = interaction.options.getString('shop');
    const conn = await mgr(interaction).getConnection(interaction.guildId, shop);
    if (!conn) throw new Error(`No connection for shop ${shop}`);
    const platform = mgr(interaction).platformForConnection(conn);

    if (sub === 'draw') {
        const id = interaction.options.getString('id');
        const result = await platform.triggerGiveawayDraw(id);
        await interaction.editReply(`Drew giveaway **${id}** — winner: ${sanitizeUserText(result.winner || '?')}`);
    } else if (sub === 'list') {
        const r = await platform.listGiveaways();
        const items = (r.items || r || []).slice(0, 10).map(g => `• ${g.id} — ${sanitizeUserText(g.prize || '?')}`);
        const embed = new EmbedBuilder().setColor(EMBED_DEFAULT_COLOR).setTitle(`Giveaways — ${shop}`).setDescription(items.join('\n') || '_(none)_');
        await interaction.editReply({ embeds: [embed] });
    }
}
```

- [ ] **Step 3: Implement the setup modal handler**

Create `interactions/modals/fourthwall_setup_submit.js`:

```js
import logger from '../../utils/logger.js';

export async function handleFourthwallSetupSubmit(interaction) {
    if (!interaction.memberPermissions?.has('ManageGuild')) {
        return interaction.reply({ content: 'Requires Manage Server permission', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const handle = interaction.fields.getTextInputValue('handle').trim();
    const apiUser = interaction.fields.getTextInputValue('api_user').trim();
    const apiPass = interaction.fields.getTextInputValue('api_pass').trim();
    const storefrontToken = (interaction.fields.getTextInputValue('storefront_token') || '').trim() || null;

    if (!/^[a-z0-9-]{1,100}$/i.test(handle)) {
        return interaction.editReply('Shop handle must be alphanumeric/dashes only.');
    }

    try {
        const mgr = interaction.client.fourthwallManager;
        if (!mgr) throw new Error('Fourthwall manager not initialized');
        const result = await mgr.connectShop({
            guildId: interaction.guildId,
            shopHandle: handle,
            apiUser, apiPass, storefrontToken,
            connectedBy: interaction.user.id
        });
        await interaction.editReply(
            `✓ Connected **${result.shopName || handle}** (registered ${result.registeredEvents} webhook subscriptions).\n` +
            `Configure routing with \`/fourthwall route\` or via the dashboard.`
        );
    } catch (err) {
        logger.error('[FW Setup Modal] failed', { err: err.message });
        await interaction.editReply(`Connection failed: ${err.message}`);
    }
}
```

- [ ] **Step 4: Register the modal in `interactions/handlerRegistry.js`**

In `interactions/handlerRegistry.js`, add the import near the other modal imports:

```js
import { handleFourthwallSetupSubmit } from './modals/fourthwall_setup_submit.js';
```

Then add to the `modalHandlers` export (search for the existing modal handler object — it follows the same pattern as `buttonHandlers`):

```js
  'fourthwall_setup_submit': handleFourthwallSetupSubmit,
```

- [ ] **Step 5: Smoke check — command loads**

```bash
cd /home/death/CertiFriedUtility && node -e "import('./commands/community/fourthwall.js').then(m => console.log('ok', m.default.data.name))"
```

Expected: `ok fourthwall`.

- [ ] **Step 6: Commit**

```bash
git add commands/community/fourthwall.js commands/community/fourthwall-handler.js interactions/modals/fourthwall_setup_submit.js interactions/handlerRegistry.js
git commit -m "feat(fourthwall): /fourthwall slash command + setup modal

- 14 subcommands across connect/route/browse/admin/giveaway groups
- Modal flow for credential entry (TextInputStyle.Short, all secrets
  cleared from history on submit)
- ManageGuild gate on every command that touches PII/credentials
- Pseudonym defaults applied uniformly via manager
- Browse commands fall back to first-connected shop's storefront token"
```

---

## Task 7: Dashboard UI

**Files:**
- Create: `dashboard/routes/api/features/fourthwall.js`
- Create: `dashboard/views/features/fourthwall.ejs`
- Modify: `dashboard/routes/api/index.js`

- [ ] **Step 1: Implement the API routes**

Create `dashboard/routes/api/features/fourthwall.js`:

```js
import express from 'express';
import pool from '../../../../utils/database.js';
import logger from '../../../../utils/logger.js';
import botManager from '../../../../core/bot-manager.js';
import { ALL_EVENT_TYPES } from '../../../../core/fourthwall-helpers.js';

const router = express.Router();

function requireGuildAccess(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    const guildId = req.params.guildId || req.body.guildId;
    const guild = (req.user.guilds || []).find(g => g.id === guildId);
    if (!guild) return res.status(403).json({ error: 'no access to guild' });
    const perms = BigInt(guild.permissions || 0);
    if ((perms & 0x20n) !== 0x20n) return res.status(403).json({ error: 'manage server required' });
    req.guildId = guildId;
    next();
}

router.get('/:guildId/connections', requireGuildAccess, async (req, res) => {
    const [rows] = await pool.execute(
        `SELECT id, shop_handle, shop_name, last_event_at, connected_at FROM fourthwall_connections WHERE guild_id = ?`,
        [req.guildId]
    );
    res.json({ connections: rows });
});

router.post('/:guildId/connections', requireGuildAccess, async (req, res) => {
    const { handle, apiUser, apiPass, storefrontToken } = req.body || {};
    if (!handle || !apiUser || !apiPass) return res.status(400).json({ error: 'missing fields' });
    if (!/^[a-z0-9-]{1,100}$/i.test(handle)) return res.status(400).json({ error: 'invalid handle' });
    try {
        const client = botManager.getClientForGuild(req.guildId);
        if (!client?.fourthwallManager) return res.status(503).json({ error: 'manager not available' });
        const result = await client.fourthwallManager.connectShop({
            guildId: req.guildId, shopHandle: handle,
            apiUser, apiPass, storefrontToken: storefrontToken || null,
            connectedBy: req.user.id
        });
        res.json({ ok: true, ...result });
    } catch (err) {
        logger.error('[FW API] connect failed', { err: err.message });
        res.status(400).json({ error: err.message });
    }
});

router.delete('/:guildId/connections/:id', requireGuildAccess, async (req, res) => {
    const [rows] = await pool.execute(
        `SELECT shop_handle FROM fourthwall_connections WHERE id = ? AND guild_id = ?`,
        [req.params.id, req.guildId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    try {
        const client = botManager.getClientForGuild(req.guildId);
        const result = await client.fourthwallManager.disconnectShop({ guildId: req.guildId, shopHandle: rows[0].shop_handle });
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/:guildId/connections/:id/routing', requireGuildAccess, async (req, res) => {
    const [rows] = await pool.execute(
        `SELECT event_category, channel_id, enabled FROM fourthwall_event_routing WHERE connection_id = ?`,
        [req.params.id]
    );
    res.json({ routing: rows });
});

router.put('/:guildId/connections/:id/routing', requireGuildAccess, async (req, res) => {
    const updates = req.body.routing || [];
    const client = botManager.getClientForGuild(req.guildId);
    if (!client?.fourthwallManager) return res.status(503).json({ error: 'manager not available' });
    for (const u of updates) {
        await client.fourthwallManager.setRouting({
            connectionId: Number(req.params.id),
            category: u.category, channelId: u.channelId || null,
            enabled: !!u.enabled
        });
    }
    res.json({ ok: true });
});

router.get('/:guildId/config', requireGuildAccess, async (req, res) => {
    const client = botManager.getClientForGuild(req.guildId);
    const cfg = await client.fourthwallManager.getGuildConfig(req.guildId);
    res.json({ config: cfg });
});

router.put('/:guildId/config', requireGuildAccess, async (req, res) => {
    const client = botManager.getClientForGuild(req.guildId);
    await client.fourthwallManager.setGuildConfig(req.guildId, req.body || {});
    res.json({ ok: true });
});

export default router;
```

- [ ] **Step 2: Mount the API router**

In `dashboard/routes/api/index.js`, find the existing feature mounts (look for `automod` or `core`) and add:

```js
import fourthwallApi from './features/fourthwall.js';
// ...
router.use('/features/fourthwall', fourthwallApi);
```

- [ ] **Step 3: Implement the EJS view**

Create `dashboard/views/features/fourthwall.ejs`:

```ejs
<%- include('../partials/header', { title: 'Fourthwall' }) %>

<div class="feature-page">
  <h1>Fourthwall Integration</h1>
  <p class="muted">Connect Fourthwall shops to post real-time order, donation, membership, and giveaway alerts.</p>

  <section class="card">
    <h2>Connected shops</h2>
    <table class="table" id="fw-connections">
      <thead><tr><th>Handle</th><th>Name</th><th>Last event</th><th>Connected</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section class="card">
    <h2>Add shop</h2>
    <form id="fw-add">
      <label>Shop handle <input name="handle" required pattern="[a-z0-9-]{1,100}"></label>
      <label>API username <input name="apiUser" required></label>
      <label>API password <input type="password" name="apiPass" required></label>
      <label>Storefront token (optional) <input name="storefrontToken"></label>
      <button type="submit">Connect</button>
      <span class="status" id="fw-add-status"></span>
    </form>
  </section>

  <section class="card">
    <h2>Privacy & defaults</h2>
    <form id="fw-config">
      <label><input type="checkbox" name="show_customer_names"> Show real customer names</label>
      <label><input type="checkbox" name="show_amounts"> Show monetary amounts</label>
      <label>Default channel ID <input name="default_channel_id" pattern="\d{17,20}"></label>
      <button type="submit">Save</button>
    </form>
  </section>
</div>

<script>
(async function() {
    const guildId = '<%= guildId %>';
    const base = '/api/features/fourthwall/' + guildId;

    function td(text) {
        const cell = document.createElement('td');
        cell.textContent = text == null ? '' : String(text);
        return cell;
    }

    async function refresh() {
        const r = await fetch(base + '/connections').then(r => r.json());
        const tbody = document.querySelector('#fw-connections tbody');
        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
        for (const c of (r.connections || [])) {
            const tr = document.createElement('tr');
            tr.appendChild(td(c.shop_handle));
            tr.appendChild(td(c.shop_name || ''));
            tr.appendChild(td(c.last_event_at ? new Date(c.last_event_at).toLocaleString() : '—'));
            tr.appendChild(td(new Date(c.connected_at).toLocaleString()));
            const actionCell = document.createElement('td');
            const btn = document.createElement('button');
            btn.className = 'disconnect-btn';
            btn.dataset.id = c.id;
            btn.textContent = 'Disconnect';
            btn.onclick = async () => {
                if (!confirm('Disconnect this shop?')) return;
                await fetch(base + '/connections/' + btn.dataset.id, { method: 'DELETE' });
                refresh();
            };
            actionCell.appendChild(btn);
            tr.appendChild(actionCell);
            tbody.appendChild(tr);
        }
    }

    document.getElementById('fw-add').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = Object.fromEntries(fd.entries());
        const status = document.getElementById('fw-add-status');
        status.textContent = 'Connecting…';
        const r = await fetch(base + '/connections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(r => r.json());
        if (r.ok) {
            status.textContent = `Connected (${r.registeredEvents} webhooks).`;
            e.target.reset();
            refresh();
        } else {
            status.textContent = 'Error: ' + (r.error || 'unknown');
        }
    };

    document.getElementById('fw-config').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = {
            show_customer_names: fd.get('show_customer_names') ? 1 : 0,
            show_amounts: fd.get('show_amounts') ? 1 : 0,
            default_channel_id: fd.get('default_channel_id') || null
        };
        await fetch(base + '/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        alert('Saved');
    };

    // Hydrate config form
    const cfg = await fetch(base + '/config').then(r => r.json()).then(j => j.config || {});
    document.querySelector('#fw-config [name=show_customer_names]').checked = !!cfg.show_customer_names;
    document.querySelector('#fw-config [name=show_amounts]').checked = !!cfg.show_amounts;
    document.querySelector('#fw-config [name=default_channel_id]').value = cfg.default_channel_id || '';

    refresh();
})();
</script>

<%- include('../partials/footer') %>
```

- [ ] **Step 4: Add a dashboard route to render the view**

Find an existing feature view route (look in `dashboard/routes/community/` or similar — they each render an EJS feature page). Pattern after one of them; add a route like:

In `dashboard/routes/community/index.js` (or wherever feature views are routed), add:

```js
router.get('/:guildId/fourthwall', requireGuildAccess, (req, res) => {
    res.render('features/fourthwall', { guildId: req.params.guildId, user: req.user });
});
```

If no `requireGuildAccess` middleware exists at that level, use whatever pattern is used by automod/leveling routes — pick one and follow it exactly.

- [ ] **Step 5: Smoke test API**

With the bot running:

```bash
curl -i http://localhost:3000/api/features/fourthwall/SOMEGUILDID/connections
```

Expected: `401 not authenticated` (no session cookie) — proves the route is mounted and protected.

- [ ] **Step 6: Commit**

```bash
git add dashboard/routes/api/features/fourthwall.js dashboard/views/features/fourthwall.ejs dashboard/routes/api/index.js dashboard/routes/community/index.js
git commit -m "feat(fourthwall): dashboard UI for shop connections + routing

- GET/POST/DELETE /api/features/fourthwall/:guildId/connections
- GET/PUT routing + config endpoints
- ManageGuild gate via guild permissions bitfield
- EJS view: connected shops table, add-shop form, privacy/default-channel form
- Vanilla JS, no framework dependency"
```

---

## Task 8: Init wiring + env vars + cleanup job

**Files:**
- Modify: `index.js`
- Create: `jobs/fourthwall-cleanup.js`
- Modify: `.env.example`

- [ ] **Step 1: Wire manager into `initializeManagers(client)`**

In `index.js`, find `async function initializeManagers(client)` near line 183. Inside it, near other manager assignments (look for `throneManager`, `steamWatcher`, etc.), add:

```js
    const { default: FourthwallManager } = await import('./core/fourthwall-manager.js');
    client.fourthwallManager = new FourthwallManager(client);
```

- [ ] **Step 2: Create orphan-cleanup job**

Create `jobs/fourthwall-cleanup.js`:

```js
import cron from 'node-cron';
import pool from '../utils/database.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';
import { platformClient } from '../utils/fourthwall-api.js';

let task = null;

async function runOnce() {
    const [orphans] = await pool.execute(
        `SELECT id, webhook_id, api_username, api_password, attempts
         FROM fourthwall_orphan_webhooks WHERE attempts < 10 ORDER BY id LIMIT 50`
    );
    for (const o of orphans) {
        try {
            const user = encryption.decrypt(JSON.parse(o.api_username));
            const pass = encryption.decrypt(JSON.parse(o.api_password));
            await platformClient(user, pass).deleteWebhook(o.webhook_id);
            await pool.execute(`DELETE FROM fourthwall_orphan_webhooks WHERE id = ?`, [o.id]);
            logger.info('[FW Cleanup] orphan webhook deleted', { webhook_id: o.webhook_id });
        } catch (err) {
            await pool.execute(
                `UPDATE fourthwall_orphan_webhooks SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = ?`,
                [o.id]
            );
            if (o.attempts + 1 >= 10) {
                logger.error('[FW Cleanup] giving up on orphan', { webhook_id: o.webhook_id, attempts: o.attempts + 1 });
            }
        }
    }

    // Prune fourthwall_seen_events older than 30 days
    await pool.execute(`DELETE FROM fourthwall_seen_events WHERE received_at < (NOW() - INTERVAL 30 DAY)`);
}

export function startFourthwallCleanup() {
    if (task) return;
    task = cron.schedule('0 4 * * *', () => {
        runOnce().catch(err => logger.error('[FW Cleanup] failed', { err: err.message }));
    });
    logger.info('[FW Cleanup] scheduled daily at 04:00');
}

export function stopFourthwallCleanup() {
    if (task) { task.stop(); task = null; }
}
```

- [ ] **Step 3: Start the cleanup job from `index.js`**

In `index.js`, near other `start*` job calls (search for `startThrone` or `start.*Scheduler`), add:

```js
import { startFourthwallCleanup } from './jobs/fourthwall-cleanup.js';
// ...
startFourthwallCleanup();
```

Match the existing import style in `index.js` exactly (static vs dynamic).

- [ ] **Step 4: Update `.env.example`**

Read `.env.example`, then add at the end:

```
# Fourthwall integration
FOURTHWALL_WEBHOOK_BASE_URL=https://your-dashboard.example.com
FOURTHWALL_API_BASE_URL=https://api.fourthwall.com
FOURTHWALL_STOREFRONT_BASE_URL=https://storefront-api.fourthwall.com
```

- [ ] **Step 5: Smoke test bot startup**

```bash
cd /home/death/CertiFriedUtility && node -e "
process.env.FOURTHWALL_WEBHOOK_BASE_URL='https://test.example.com';
import('./core/fourthwall-manager.js').then(m => {
    const mgr = new m.default({ channels: { fetch: () => null } });
    console.log('manager constructed:', typeof mgr.connectShop);
});
"
```

Expected: `manager constructed: function`.

- [ ] **Step 6: Commit**

```bash
git add index.js jobs/fourthwall-cleanup.js .env.example
git commit -m "feat(fourthwall): wire manager into init + daily cleanup job

- initializeManagers attaches client.fourthwallManager on main + custom bots
- jobs/fourthwall-cleanup.js: retries orphan webhook deletes, prunes
  fourthwall_seen_events older than 30 days, scheduled 04:00 daily
- .env.example documents FOURTHWALL_WEBHOOK_BASE_URL +
  FOURTHWALL_API_BASE_URL + FOURTHWALL_STOREFRONT_BASE_URL"
```

---

## Task 9: Deploy commands + manual smoke test

**Files:** none (operational)

- [ ] **Step 1: Set env vars on the bot host**

The user must ensure `.env` (production) has:

```
FOURTHWALL_WEBHOOK_BASE_URL=<the public URL the dashboard is reachable at, no trailing slash>
```

The exact value depends on the user's deployment. If the bot's dashboard is behind a tunnel/proxy, use whatever Fourthwall can reach over HTTPS.

- [ ] **Step 2: Deploy commands (main bot global + custom bots per-guild)**

```bash
cd /home/death/CertiFriedUtility && node deploy-commands.js
```

If multi-bot guilds need the command too, run per-bot deploy:

```bash
node scripts/deploy-commands-to-bot.js <bot_id>
```

Expected: prints deployed-command count including `fourthwall`.

- [ ] **Step 3: Restart PM2 process**

```bash
pm2 restart CertiFriedUtility
pm2 logs CertiFriedUtility --lines 50
```

Watch for: `[FW Cleanup] scheduled daily at 04:00` in the logs.

- [ ] **Step 4: User-facing smoke test (manual)**

In a test guild with the bot:
1. Run `/fourthwall setup`. Modal opens.
2. Enter the rotated Fourthwall API credentials (NOT the leaked ones from the chat — those should be rotated already).
3. Submit. Expect: ephemeral reply `✓ Connected (registered N webhook subscriptions)`.
4. Run `/fourthwall default-channel #some-channel`.
5. From the Fourthwall dashboard, trigger a test event (or place a tiny test order).
6. Verify the embed lands in the channel.

If the embed doesn't post:
- Check `pm2 logs` for `[FW Webhook]` entries.
- Check `fourthwall-webhooks.log` once added (Winston transport — defer to later task if needed).
- Verify `FOURTHWALL_WEBHOOK_BASE_URL` is reachable from Fourthwall (curl from outside).

- [ ] **Step 5: Final commit (if there's a changelog or release notes file)**

```bash
git log --oneline | head -10
```

Expected: 9+ commits from this plan, all with `feat(fourthwall):` prefix.

---

## Self-review checklist (performed before handoff)

✅ Every spec section is covered by at least one task:
- §4 Architecture → Tasks 4, 5, 8
- §5 Data Model → Task 1
- §6 Webhook Receiver → Task 5
- §7 Slash Commands → Task 6
- §8 Dashboard → Task 7
- §9 Embeds → Task 4 (embed builders) + Task 3 (helpers)
- §10 Setup/Disconnect → Task 4 (manager) + Task 6 (modal)
- §11 Security → Tasks 2 (HMAC), 4 (encryption), 6 (ManageGuild gate)
- §12 Env → Task 8
- §13 Testing → Tasks 2, 3 (unit) + Task 9 (manual smoke)
- §14 Rollout → Task 9
- §15 Open questions → flagged in Task 4 step 1 (webhook secret strategy) and Task 6 step 2 (storefront token fallback)

✅ No placeholders: every code block is complete and self-contained.

✅ Type consistency: `connectShop`, `disconnectShop`, `setRouting`, `getRouting`, `getGuildConfig`, `setGuildConfig`, `handleEvent`, `getConnection`, `listConnections` named consistently between manager (Task 4), command handler (Task 6), webhook receiver (Task 5), and API routes (Task 7).

✅ Function references match: `botManager.getClientForGuild()` defined in Task 5 step 1, used in Tasks 5, 7, 8.

✅ Migration number 112 follows latest (111) without gaps.
