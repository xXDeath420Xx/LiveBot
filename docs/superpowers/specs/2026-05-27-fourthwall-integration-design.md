# Fourthwall Integration — Design Spec

**Date:** 2026-05-27
**Status:** Draft → pending approval
**Author:** xXDeath420Xx (via Claude)
**Reference integration:** [Throne Wishlist Integration](../../../utils/scrapers/throne-scraper.js) (Throne is scrape-based; Fourthwall replaces scraping with a proper REST API + webhooks)

---

## 1. Purpose

Replace the absence of any Fourthwall presence in CertiFried with a first-class integration so creators who run Fourthwall shops (donations, products, memberships, giveaways, etc.) get real-time Discord notifications, shop browsing, and admin tooling — analogous in spirit to the existing Throne wishlist integration but built on Fourthwall's real APIs (no scraping required).

## 2. Goals

- Real-time Discord notifications for shop events (orders, donations, memberships, giveaways, promotions, newsletter signups, thank-you messages, abandoned carts).
- Public shop browsing from Discord (`/fourthwall shop`, `/fourthwall product`, `/fourthwall collection`, `/fourthwall search`).
- Per-guild creator-facing admin tooling (`/fourthwall stats`, `/fourthwall recent`, `/fourthwall giveaway draw`).
- Multi-shop-per-guild support (matches existing Throne multi-tracking pattern).
- Multi-bot support: works on the main bot and all custom bots without per-bot configuration.
- Strong defaults around customer-data privacy (pseudonyms, hidden amounts opt-in).

## 3. Non-goals

- OAuth-published Fourthwall app (deferred; Basic Auth API keys only for v1).
- Selling products via Discord (no cart/checkout flow — link out to Fourthwall storefront).
- Reverse direction: bot → FW writes are limited to webhook registration/deletion and giveaway-draw triggering. No order creation, no product editing.
- Polling fallback. Pure webhook architecture with on-demand resync command.

## 4. Architecture

### 4.1 Components

| Layer | File | Purpose |
|---|---|---|
| API client | `utils/fourthwall-api.js` | Platform + Storefront API wrapper, Basic-Auth header, HMAC verifier, error normalization |
| Manager | `core/fourthwall-manager.js` | Per-bot business logic: connect, disconnect, event dispatch, embed builders, resync |
| Webhook receiver | `dashboard/routes/webhooks/fourthwall.js` | `POST /webhooks/fourthwall/:token` — HMAC verify + dispatch |
| Slash command | `commands/community/fourthwall.js` + `fourthwall-handler.js` | `/fourthwall` with subcommands |
| Dashboard UI | `dashboard/views/features/fourthwall.ejs` + `dashboard/routes/api/features/fourthwall.js` | Connection setup, channel routing, event toggles |
| Migration | `migrations/112_fourthwall_integration.js` | DB schema |
| Modal handlers | Registered in `interactions/handlerRegistry.js` | `fw_setup_modal` prefix for setup modal submit |

### 4.2 Data flow — notification

```
Fourthwall fires event
  → POST https://<dashboard>/webhooks/fourthwall/<token> (HMAC sig in header)
  → dashboard/routes/webhooks/fourthwall.js
      - raw-body capture, HMAC verify with timing-safe compare
      - lookup connection row by :token
      - INSERT IGNORE into fourthwall_seen_events (dedupe replays)
      - respond 204 immediately
      - setImmediate(() => botManager.getClientForGuild(connection.guild_id).fourthwallManager.handleEvent(...))
  → manager.handleEvent
      - resolve routed channel via fourthwall_event_routing (fallback default_channel_id)
      - build category-specific embed (privacy filters applied)
      - client.channels.fetch + send with AllowedMentions: { parse: [] }
```

### 4.3 Data flow — browse command

```
/fourthwall product slug:<x>
  → handler → utils/fourthwall-api.js storefront client
  → GET /v1/products/<slug> with X-Storefront-Token header (or shop's storefront_token)
  → embed reply (ephemeral or public per subcommand convention)
```

### 4.4 Multi-bot routing

- `index.js` → `initializeManagers(client)` adds `client.fourthwallManager = new FourthwallManager(client)`. Matches existing Throne/Steam pattern.
- `core/bot-manager.js` exposes `getClientForGuild(guildId)` returning the correct bot client (custom or main) based on `guild_bot_mapping`.
- The webhook receiver lives in the shared dashboard process (singleton across bots). It dispatches to the right `client.fourthwallManager` via `getClientForGuild`.
- If the target client isn't online when an event arrives, the row is still marked seen (preventing replay) plus stored in `fourthwall_undelivered_events` for manual replay.

## 5. Data Model

Migration `migrations/112_fourthwall_integration.js`:

```sql
CREATE TABLE fourthwall_connections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild_id VARCHAR(20) NOT NULL,
    shop_handle VARCHAR(100) NOT NULL,
    shop_name VARCHAR(255) DEFAULT NULL,
    shop_id VARCHAR(100) DEFAULT NULL,
    api_username VARCHAR(255) NOT NULL,         -- encrypted JSON
    api_password TEXT NOT NULL,                  -- encrypted JSON
    storefront_token VARCHAR(255) DEFAULT NULL,  -- plaintext (ptkn_ public by design)
    connection_token VARCHAR(64) NOT NULL,       -- URL-path secret
    webhook_secret VARCHAR(255) NOT NULL,        -- encrypted JSON (HMAC secret)
    webhook_ids JSON DEFAULT NULL,
    connected_by VARCHAR(20) NOT NULL,
    connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_event_at TIMESTAMP DEFAULT NULL,
    UNIQUE KEY uk_guild_shop (guild_id, shop_handle),
    UNIQUE KEY uk_connection_token (connection_token),
    INDEX idx_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE fourthwall_event_routing (
    connection_id INT NOT NULL,
    event_category ENUM('orders','donations','memberships','giveaways','promotions','newsletter','thank_you','cart_abandoned') NOT NULL,
    channel_id VARCHAR(20) DEFAULT NULL,
    enabled TINYINT(1) DEFAULT 1,
    PRIMARY KEY (connection_id, event_category),
    FOREIGN KEY (connection_id) REFERENCES fourthwall_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE fourthwall_guild_config (
    guild_id VARCHAR(20) PRIMARY KEY,
    default_channel_id VARCHAR(20) DEFAULT NULL,
    show_customer_names TINYINT(1) DEFAULT 0,
    show_amounts TINYINT(1) DEFAULT 1,
    embed_color VARCHAR(7) DEFAULT '#FF6B35'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE fourthwall_seen_events (
    event_id VARCHAR(100) PRIMARY KEY,
    connection_id INT NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE fourthwall_orphan_webhooks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    connection_id INT NOT NULL,
    webhook_id VARCHAR(100) NOT NULL,
    api_username VARCHAR(255) NOT NULL,   -- encrypted; needed to delete after parent row gone
    api_password TEXT NOT NULL,            -- encrypted
    attempts INT DEFAULT 0,
    last_attempt_at TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE fourthwall_undelivered_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    connection_id INT NOT NULL,
    event_id VARCHAR(100) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSON NOT NULL,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (connection_id) REFERENCES fourthwall_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Pruning: `fourthwall_seen_events` rows older than 30 days deleted by the daily log-retention job.

## 6. Webhook Receiver

Route: `POST /webhooks/fourthwall/:token`

Verification flow:

1. Read raw body via `express.raw({ type: 'application/json', limit: '1mb' })` — must be mounted **before** `express.json()`.
2. Read `X-Fourthwall-Hmac-Sha256` header.
3. Lookup connection by `connection_token`. Unknown → `404`.
4. Decrypt `webhook_secret`. Compute `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')`.
5. Compare with `crypto.timingSafeEqual` (after length check). Mismatch → `401`.
6. Parse JSON, extract `event_id` + `event_type`.
7. `INSERT IGNORE INTO fourthwall_seen_events`. Replay → `204` and stop.
8. Return `204` to FW immediately.
9. `setImmediate` → dispatch to `botManager.getClientForGuild(connection.guild_id).fourthwallManager.handleEvent(eventType, payload, connection)`.

Errors during dispatch are caught and logged but do not affect FW's view of delivery.

## 7. Slash Command Surface

```
# Connection management (mod: ManageGuild)
/fourthwall setup
/fourthwall disconnect shop:<handle>
/fourthwall list
/fourthwall resync shop:<handle> hours:<1-72>

# Routing
/fourthwall route shop:<handle> category:<...> channel:<#chan> [enabled:<bool>]
/fourthwall default-channel channel:<#chan>
/fourthwall privacy show_names:<bool> show_amounts:<bool>

# Browse (anyone)
/fourthwall shop [handle]
/fourthwall product slug:<x> [shop:<handle>]
/fourthwall collection slug:<x> [shop:<handle>]
/fourthwall search query:<x> [shop:<handle>]
/fourthwall promotions [shop:<handle>]

# Admin (mod)
/fourthwall stats shop:<handle> [period:<7d|30d|all>]
/fourthwall recent shop:<handle> kind:<orders|donations|members> [limit:<5-25>]
/fourthwall giveaway draw shop:<handle> id:<draw_id>
/fourthwall giveaway list shop:<handle>
```

Setup modal: handle / api_user / api_pass / storefront_token (optional). Modal handler ID: `fw_setup_modal`, registered in `interactions/handlerRegistry.js`.

## 8. Dashboard Surface

Route: `/dashboard/:guildId/fourthwall` (uses existing `dashboard/middleware/auth.js`).

Three cards:
1. **Connected shops** — table with status badge, last event time, Disconnect + Resync buttons.
2. **Add shop** — four-field form with "Test connection" button.
3. **Per-shop routing** — 8-category × {channel, enabled} matrix.

API routes:
- `GET /api/features/fourthwall/connections`
- `POST /api/features/fourthwall/connections`
- `DELETE /api/features/fourthwall/connections/:id`
- `GET /api/features/fourthwall/connections/:id/routing`
- `PUT /api/features/fourthwall/connections/:id/routing`
- `POST /api/features/fourthwall/connections/:id/resync`
- `POST /api/features/fourthwall/connections/:id/test`

## 9. Notification Embeds

Color: `#FF6B35` default, overridable per guild.

| Category | FW events | Embed |
|---|---|---|
| `orders` | ORDER_PLACED, ORDER_UPDATED, GIFT_PURCHASE | Product list (top 3), total (if `show_amounts`), shipping country, order # last-4 |
| `donations` | ORDER_DONATION | Big amount field, donor (pseudonym unless opted in), optional sanitized message ≤500 chars |
| `memberships` | SUBSCRIPTION_PURCHASED/CHANGED/EXPIRED | Tier name, period, member pseudonym |
| `giveaways` | GIVEAWAY_DRAW_STARTED/ENDED | Prize, draw ID, entry count, winner (when ended) |
| `promotions` | PROMOTION_CREATED/UPDATED/STATUS_CHANGED | Code, discount, expiry, applicable products |
| `newsletter` | NEWSLETTER_SUBSCRIBED | "📬 +1 newsletter subscriber" (counter only, no PII) |
| `thank_you` | THANK_YOU_MESSAGE_SENT | Customer pseudonym + sanitized message |
| `cart_abandoned` | CART_ABANDONED_1H/24H/72H | Counter + cart total; default-disabled, internal mod channel only |

Sanitization (applied universally before send):
- `escapeMarkdown` on user strings.
- `AllowedMentions: { parse: [] }`.
- Truncate to 1024 chars/field with ellipsis.
- Currency via `Intl.NumberFormat(locale, { style:'currency', currency: payload.currency })`.

Pseudonyms when `show_customer_names = 0`: `Supporter #${hash(customer_id + guild_id) % 9000 + 1000}`. Stable per customer, no PII leak.

## 10. Setup & Disconnect Flow Detail

### connectShop

```
1. Validate inputs (regex per field).
2. GET /v1/shop with Basic Auth → expect 200, cache shop_id + shop_name.
3. connection_token = crypto.randomBytes(24).toString('base64url').
4. INSERT fourthwall_connections (encrypted creds, token; webhook_secret + ids NULL initially).
5. For each event type in our 8 categories (~17 FW event types total):
     POST /v1/webhooks { url: `${WEBHOOK_BASE_URL}/webhooks/fourthwall/${token}`, eventType }
     First response yields the connection's HMAC secret; subsequent calls reuse.
     Collect webhook IDs.
6. UPDATE row with encrypted webhook_secret + webhook_ids JSON.
7. INSERT fourthwall_event_routing rows (cart_abandoned defaults enabled=0; rest enabled=1).
8. Return {connectionId, registeredEvents}.
```

Partial-failure handling: if step 5 fails mid-way, the row exists in a "needs re-registration" state surfaced by `/fourthwall list` health check. A `POST /api/features/fourthwall/connections/:id/retry-webhooks` route re-runs step 5.

### disconnectShop

```
1. SELECT connection row.
2. For each id in webhook_ids: DELETE /v1/webhooks/{id} (collect failures).
3. For each failure: INSERT into fourthwall_orphan_webhooks (with encrypted creds copy for later cleanup).
4. DELETE local connection row (CASCADE: event_routing, seen_events, undelivered_events).
5. Return {removedFwCount, orphanedCount}.
```

Daily cleanup job (added to existing `jobs/log-retention.js` or new `jobs/fourthwall-cleanup.js`) retries orphan webhook deletes; gives up + alerts after 10 attempts.

## 11. Security

- All Platform API creds + webhook HMAC secret encrypted via `utils/encryption.js` AES-256-GCM. Same key (`BOT_ENCRYPTION_KEY`) as `custom_bots.bot_token`.
- Decryption only in memory at point of use; never logged.
- `connection_token`: 24 random bytes, base64url, unique-indexed. Return same coarse response for unknown-token vs HMAC fail (both `401`) to avoid enumeration.
- Storefront token (`ptkn_*`) stored plaintext (designed-public).
- Commands surfacing PII (`/fourthwall recent`, detailed `/fourthwall stats`) gated on `PermissionFlagsBits.ManageGuild`.
- Default privacy: pseudonyms on, opt-in real names.
- All webhook traffic logged to dedicated Winston transport `fourthwall-webhooks.log`.
- Setup rate-limited: 5/hour per guild (in-memory + DB-backed counter).

## 12. Environment

```
FOURTHWALL_WEBHOOK_BASE_URL=https://dashboard.certifried.example.com   # required
FOURTHWALL_API_BASE_URL=https://api.fourthwall.com                      # default
```

## 13. Testing strategy

- **Unit**: HMAC verifier with known fixture; embed builders against snapshot payloads; pseudonym hash stability.
- **Integration**: webhook receiver with raw-body fixture (real FW sample payloads); dedupe behavior; partial-failure retry on `connectShop`.
- **Manual smoke**: connect xXDeath420Xx's shop with provided creds (rotated post-paste), fire test webhooks via FW dashboard, verify embed in a test channel.
- **Multi-bot**: connect from a guild served by a custom bot, verify webhook dispatch routes through the right client.

## 14. Rollout plan

1. Land migration 112 + manager + API client + webhook receiver behind the existing dashboard process restart.
2. Set `FOURTHWALL_WEBHOOK_BASE_URL` env var on the bot host.
3. Deploy slash commands (main bot global + per-guild custom bots).
4. Soak test on user's own shop for ~3 days; monitor `fourthwall-webhooks.log`.
5. Document in CHANGELOG; surface in dashboard navigation.

## 15. Open questions for implementer

- Exact `event_type` strings FW sends in headers vs payload body — needs verification against `https://docs.fourthwall.com/llms.txt` event reference during build.
- Confirm whether FW returns one HMAC secret per shop or per webhook subscription. If per-subscription, switch to a `webhook_secrets` map keyed by event type and look up by inbound header instead.
- Confirm storefront token requirement for public product lookups vs whether unauthenticated requests work for some endpoints — affects whether `/fourthwall product` works for shops without a connection.

## 16. References

- Fourthwall docs: https://docs.fourthwall.com/
- LLM-friendly reference: https://docs.fourthwall.com/llms.txt
- Throne integration pattern: `core/throne-manager.js`, `utils/scrapers/throne-scraper.js`, `migrations/080_throne_integration.js`
- Encryption: `utils/encryption.js`
- Bot manager: `core/bot-manager.js`
- Modal handler registry: `interactions/handlerRegistry.js`
