# Image-Based Scam Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OCR image attachments and route the extracted text through the existing phishing pipeline so scam *screenshots* (e.g. fake-MrBeast crypto-casino lures) are removed/actioned everywhere except reports/red-flags channels.

**Architecture:** Add two focused, independently-testable units — a pure scam-genre text classifier and an OCR helper (sharp preprocess + tesseract.js singleton worker) — then wire them into `core/phishing-detection-manager.js`'s `checkMessage` so image-derived text joins the existing domain-blocklist + evidence-exemption + `takeAction` flow. A new `scan_images` config column gates it per guild.

**Tech Stack:** Node 20 (ESM), discord.js v14, `tesseract.js@7`, `sharp@0.34`, MySQL (`utils/db.js` default `pool`), `node:test`.

**Conventions to follow:**
- ESM imports (`import x from '...'`); DB via `import pool from '../utils/db.js'` then `pool.execute(sql, params)`.
- Migrations are idempotent and applied directly (NOT via the buggy `migrations/run.js`): `import { up } from './migrations/NNN.js'; await up(pool)`.
- Tests live in `tests/` (gitignored — run locally, do NOT `git add` them).
- Logging via `import logger from '../utils/logger.js'` (`logger.info/warn/error`).
- Never run scripts that log in a custom bot token while PM2 is running (read-only DB scripts and local-file OCR are fine — no Discord gateway session).

---

### Task 1: Migration — `scan_images` column on `phishing_config`

**Files:**
- Create: `migrations/120_phishing_scan_images.js`

- [ ] **Step 1: Write the migration**

```js
/**
 * Migration 120: Phishing detection — image OCR scanning toggle
 *
 * Adds a per-guild flag that gates OCR-based scam-image scanning. DEFAULT 1 so
 * every guild already opted into phishing detection gets image scanning; can be
 * turned off per guild. Idempotent (column-existence check).
 */
async function columnExists(db, table, column) {
    const allowedTables = new Set(['phishing_config']);
    const allowedColumns = new Set(['scan_images']);
    if (!allowedTables.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    if (!allowedColumns.has(column)) throw new Error(`Refusing to inspect unknown column: ${column}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await columnExists(db, 'phishing_config', 'scan_images'))) {
        await db.execute(
            'ALTER TABLE phishing_config ADD COLUMN scan_images TINYINT(1) NOT NULL DEFAULT 1 AFTER log_detections'
        );
    }
}

export async function down(db) {
    if (await columnExists(db, 'phishing_config', 'scan_images')) {
        await db.execute('ALTER TABLE phishing_config DROP COLUMN scan_images');
    }
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check migrations/120_phishing_scan_images.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit** (migration applied later in Task 6, after code is ready)

```bash
git add migrations/120_phishing_scan_images.js
git commit -m "feat(phishing): add scan_images config column (migration 120)"
```

---

### Task 2: Pure scam-genre text classifier (TDD)

**Files:**
- Create: `core/scam-text-classifier.js`
- Test: `tests/scam-text-classifier.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreScamText, SIGNAL_GROUPS } from '../core/scam-text-classifier.js';

// Approximate OCR output of docs/scam.jpg (the fake-MrBeast crypto casino post).
const SCAM = `MrBeast @MrBeast 53m
I'm excited to announce the launch of my very own crypto casino! To celebrate,
I'm giving away $5,600 to everyone who registers - and you can withdraw the bonus instantly.
How to claim your reward:
1. Go to bozawin.com
2. Enter the special promo code: BOZA5600
3. Receive your $5,600 bonus
This post will be deleted one hour after publication.`;

test('scoreScamText: flags the sample scam with >=3 distinct groups', () => {
    const r = scoreScamText(SCAM);
    assert.equal(r.matched, true);
    assert.ok(r.groups.length >= 3, `expected >=3 groups, got ${r.groups.join(',')}`);
    assert.ok(r.groups.includes('gambling'));
    assert.ok(r.groups.includes('promo'));
});

test('scoreScamText: a single casual giveaway mention is NOT flagged', () => {
    const r = scoreScamText('anyone want to join my giveaway? winner gets a free game key');
    assert.equal(r.matched, false);
    assert.ok(r.groups.length < 3);
});

test('scoreScamText: two unrelated signals stay under threshold', () => {
    // money + deposit (lure) = 2 groups, must not trip the >=3 bar
    const r = scoreScamText('I deposited $50 into my account today');
    assert.equal(r.matched, false);
});

test('scoreScamText: empty/blank input is safe', () => {
    assert.equal(scoreScamText('').matched, false);
    assert.equal(scoreScamText(null).matched, false);
    assert.equal(scoreScamText(undefined).matched, false);
});

test('SIGNAL_GROUPS: exposes the expected group keys', () => {
    assert.deepEqual(
        Object.keys(SIGNAL_GROUPS).sort(),
        ['gambling', 'giveaway', 'lure', 'money', 'promo', 'urgency']
    );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/scam-text-classifier.test.js`
Expected: FAIL — `Cannot find module '../core/scam-text-classifier.js'`.

- [ ] **Step 3: Implement the classifier**

```js
/**
 * Pure scam-genre text classifier.
 *
 * Used by phishing detection on text recovered from image attachments (OCR).
 * Counts how many DISTINCT signal groups appear; a message is flagged only when
 * >= MATCH_THRESHOLD groups are present. A high bar keeps false positives low,
 * which matters because the caller applies a punitive action on a match.
 */

export const MATCH_THRESHOLD = 3;

export const SIGNAL_GROUPS = {
    gambling: [
        /crypto\s*casino/i, /\bcasino\b/i, /\bbetting\b/i, /\bslots?\b/i,
        /\bjackpot\b/i, /\bgambl/i, /\broulette\b/i, /\bwager\b/i,
    ],
    giveaway: [
        /giv(?:e|ing)\s*away/i, /\bgiveaway\b/i, /free\s*\$?\d/i, /\bairdrop\b/i,
        /claim\s+your\s+(?:reward|prize|bonus|gift|winnings)/i,
        /free\s*(?:nitro|crypto|bitcoin|btc|eth|robux|steam)/i,
    ],
    promo: [
        /promo\s*code/i, /bonus\s*code/i, /special\s*(?:promo\s*)?code/i,
        /use\s*(?:the\s*)?code/i, /referral\s*code/i, /coupon\s*code/i,
    ],
    urgency: [
        /will\s*be\s*deleted/i, /don'?t\s*miss/i, /limited\s*time/i,
        /act\s*(?:now|fast)/i, /\bexpires?\b/i, /\bhurry\b/i,
        /(?:one|1)\s*hour\s*after/i, /while\s*(?:it\s*)?lasts/i, /last\s*chance/i,
    ],
    money: [
        /\$\s?\d{2,}(?:[.,]\d{3})*/, /\b\d+\s?(?:usd|btc|eth|sol|dollars?)\b/i,
    ],
    lure: [
        /withdraw[^.]{0,30}instant/i, /instant[^.]{0,30}withdraw/i, /\bdeposit\b/i,
        /(?:register|sign\s*up)[^.]{0,40}bonus/i, /receive\s*your\s*\$?\d/i,
    ],
};

/**
 * @param {string} text
 * @returns {{ matched: boolean, groups: string[] }}
 */
export function scoreScamText(text) {
    const str = String(text ?? '');
    if (!str.trim()) return { matched: false, groups: [] };

    const groups = [];
    for (const [name, patterns] of Object.entries(SIGNAL_GROUPS)) {
        if (patterns.some(re => re.test(str))) groups.push(name);
    }
    return { matched: groups.length >= MATCH_THRESHOLD, groups };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/scam-text-classifier.test.js`
Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add core/scam-text-classifier.js
git commit -m "feat(phishing): pure scam-genre text classifier"
```

---

### Task 3: OCR helper (sharp preprocess + tesseract.js singleton worker)

**Files:**
- Create: `core/scam-image-ocr.js`

- [ ] **Step 1: Implement the OCR helper**

```js
/**
 * Scam-image OCR helper.
 *
 * extractImageText(attachments) downloads image attachments, preprocesses them
 * with sharp (the inputs are photos of screens — glare/angle — so grayscale +
 * normalize + a bounded resize materially improves OCR), and runs tesseract.js
 * through a lazy SINGLETON worker guarded by an async mutex (one OCR job at a
 * time -> bounded memory). Per-image timeout. FAILS OPEN: any error/timeout ->
 * '' so the message pipeline never throws or stalls.
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import logger from '../utils/logger.js';

const MAX_IMAGES = 2;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const OCR_TIMEOUT_MS = 10_000;

let workerPromise = null;
async function getWorker() {
    if (!workerPromise) {
        workerPromise = createWorker('eng').catch(err => {
            workerPromise = null; // allow retry on next call
            throw err;
        });
    }
    return workerPromise;
}

// Serialize OCR jobs: chain every call onto the previous so only one runs at once.
let queue = Promise.resolve();
function runExclusive(fn) {
    const result = queue.then(fn, fn);
    queue = result.then(() => {}, () => {});
    return result;
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function ocrOneBuffer(buffer) {
    const pre = await sharp(buffer)
        .grayscale()
        .resize(1400, 1400, { fit: 'inside', withoutEnlargement: false })
        .normalize()
        .png()
        .toBuffer();
    const worker = await getWorker();
    const { data } = await worker.recognize(pre);
    return (data?.text || '').trim();
}

/**
 * @param {Iterable<{contentType?: string, size?: number, url: string}>} attachments
 * @returns {Promise<string>} concatenated OCR text ('' on any failure)
 */
export async function extractImageText(attachments) {
    const images = [...attachments]
        .filter(a => a.contentType?.startsWith('image/'))
        .filter(a => !a.size || a.size <= MAX_BYTES)
        .slice(0, MAX_IMAGES);
    if (images.length === 0) return '';

    const texts = [];
    for (const att of images) {
        try {
            const res = await fetch(att.url);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > MAX_BYTES) continue;
            const text = await runExclusive(() => withTimeout(ocrOneBuffer(buf), OCR_TIMEOUT_MS, 'ocr'));
            if (text) texts.push(text);
        } catch (err) {
            logger.warn('[ScamImageOCR] OCR failed for attachment', { url: att.url, error: err.message });
        }
    }
    return texts.join('\n');
}

/** Gracefully terminate the OCR worker (optional shutdown wiring). */
export async function terminateScamOcrWorker() {
    if (!workerPromise) return;
    try {
        const worker = await workerPromise;
        await worker.terminate();
    } catch { /* ignore */ }
    workerPromise = null;
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check core/scam-image-ocr.js`
Expected: no output (exit 0).

- [ ] **Step 3: Integration proof against the real sample image**

Create a throwaway script `/tmp/ocr-proof.mjs`:

```js
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { scoreScamText } from '/home/death/CertiFriedUtility/core/scam-text-classifier.js';

const buf = await readFile('/home/death/CertiFriedUtility/docs/scam.jpg');
const pre = await sharp(buf).grayscale().resize(1400, 1400, { fit: 'inside', withoutEnlargement: false }).normalize().png().toBuffer();
const worker = await createWorker('eng');
const { data } = await worker.recognize(pre);
await worker.terminate();
const text = data.text || '';
console.log('--- OCR TEXT (first 600 chars) ---');
console.log(text.slice(0, 600));
const r = scoreScamText(text);
console.log('--- CLASSIFIER ---', JSON.stringify(r));
console.log('contains bozawin:', /bozawin/i.test(text), '| casino:', /casino/i.test(text), '| promo:', /promo/i.test(text));
```

Run: `node /tmp/ocr-proof.mjs`
Expected: printed OCR text recognizably containing "casino", "promo code", and a `bozawin`-like token (OCR may garble a few characters); `CLASSIFIER` shows `"matched":true` with ≥3 groups. If `matched` is false, widen the genre patterns in `core/scam-text-classifier.js` to cover the actual OCR output and re-run Task 2's tests + this proof. Do NOT commit `/tmp/ocr-proof.mjs`.

- [ ] **Step 4: Commit**

```bash
git add core/scam-image-ocr.js
git commit -m "feat(phishing): image OCR helper (sharp + tesseract singleton)"
```

---

### Task 4: Wire OCR + classifier into `checkMessage`

**Files:**
- Modify: `core/phishing-detection-manager.js` (imports near top; `checkMessage` ~lines 287-326; `takeAction` signature ~line 331)

- [ ] **Step 1: Add imports**

At the top of `core/phishing-detection-manager.js`, after the existing imports, add:

```js
import { extractImageText } from './scam-image-ocr.js';
import { scoreScamText } from './scam-text-classifier.js';
```

- [ ] **Step 2: Replace the body of `checkMessage`**

Replace the current `checkMessage` method (from `async checkMessage(message) {` through its closing `return false;\n    }`) with:

```js
    async checkMessage(message) {
        // Skip bots and DMs
        if (message.author.bot || !message.guild) return false;

        // Skip admins, owners, and whitelisted users
        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = message.member.id === message.guild.ownerId;
            if (isAdmin || isOwner) return false;
        }
        if (await isWhitelisted(message.guild.id, message.author.id)) return false;

        // Fast bail: nothing to scan unless there's a URL in text OR an image attachment.
        const hasImages = message.attachments.some(a => a.contentType?.startsWith('image/'));
        const hasUrlInText = /https?:\/\//i.test(message.content || '');
        if (!hasImages && !hasUrlInText) return false;

        // Get guild config
        const config = await this.getConfig(message.guild.id);
        if (!config) return false;

        // Layer 1: Channel exemption — skip entirely (covers reports/red-flags channels)
        if (this.isExemptChannel(message.channel, config)) return false;

        // OCR image attachments (only when enabled) and fold the text into the scan.
        let ocrText = '';
        if (hasImages && config.scan_images) {
            ocrText = await extractImageText(message.attachments.values());
        }

        const combined = `${message.content || ''}\n${ocrText}`;
        const domains = this.extractDomains(combined);

        // Known phishing domain (in text OR image) — high confidence.
        for (const { domain, url } of domains) {
            if (this.domainSet.has(domain) && !this.isWhitelisted(domain, config)) {
                const source = ocrText && new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(ocrText)
                    ? 'image-domain' : 'auto-list';
                if (this.looksLikeEvidencePost(message)) {
                    await this.forwardEvidencePost(message, domain, url, config);
                    return true;
                }
                await this.takeAction(message, domain, url, config, source);
                return true;
            }
        }

        // Scam-genre heuristic — runs ONLY on image-derived text (never plain chat).
        if (ocrText) {
            const genre = scoreScamText(ocrText);
            if (genre.matched) {
                const reason = `image-scam (${genre.groups.join('+')})`;
                if (this.looksLikeEvidencePost(message)) {
                    await this.forwardEvidencePost(message, reason, '(in image)', config);
                    return true;
                }
                await this.takeAction(message, reason, '(text inside image)', config, 'image-genre');
                return true;
            }
        }

        return false;
    }
```

- [ ] **Step 3: Generalize `takeAction` to accept an explicit source**

Change the `takeAction` signature and its DB-log `source` line. Replace:

```js
    async takeAction(message, matchedDomain, matchedUrl, config) {
```
with:
```js
    async takeAction(message, matchedDomain, matchedUrl, config, source = null) {
```

Then inside `takeAction`, replace this line:
```js
                const source = this.domainSet.has(matchedDomain) ? 'auto-list' : 'manual';
```
with:
```js
                const detectionSource = source || (this.domainSet.has(matchedDomain) ? 'auto-list' : 'manual');
```
and update the very next `pool.execute` call's params array, changing the trailing `source` to `detectionSource`:
```js
                    [guild.id, author.id, channel.id, matchedDomain, matchedUrl, detectionSource, config.action]
```

(Leave the rest of `takeAction` — delete, owner-protection, action switch, alert embed — unchanged. The alert's "Matched Domain" field will now show e.g. `image-scam (gambling+promo+money)`, which is the desired mod context.)

- [ ] **Step 4: Syntax-check**

Run: `node --check core/phishing-detection-manager.js`
Expected: no output (exit 0).

- [ ] **Step 5: Re-run the classifier unit tests (guard against accidental shared-file breakage)**

Run: `node --test tests/scam-text-classifier.test.js`
Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add core/phishing-detection-manager.js
git commit -m "feat(phishing): scan image attachments via OCR for scam content"
```

---

### Task 5: Deploy

**Files:** none (operational)

- [ ] **Step 1: Apply migration 120**

Create `/tmp/apply120.mjs`:
```js
import pool from '/home/death/CertiFriedUtility/utils/db.js';
import { up } from '/home/death/CertiFriedUtility/migrations/120_phishing_scan_images.js';
await up(pool);
const [c] = await pool.execute("SELECT column_name, column_default FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='phishing_config' AND column_name='scan_images'");
console.log('scan_images column:', JSON.stringify(c[0] || null));
await pool.end();
```
Run: `node /tmp/apply120.mjs`
Expected: `scan_images column: {"column_name":"scan_images","column_default":"1"}`.

- [ ] **Step 2: Restart the bot**

Run: `pm2 restart CertiFriedUtility`
Then wait ~12s and check status is `online`:
`pm2 jlist | node -e 'const a=JSON.parse(require("fs").readFileSync(0));const p=a.find(x=>x.name==="CertiFriedUtility");console.log("status:",p?.pm2_env?.status)'`
Expected: `status: online`.

- [ ] **Step 3: Verify clean startup (no scam/OCR errors)**

Run: `grep -aiE "ScamImageOCR|scam-text|phishing.*Error|SyntaxError" /home/death/.pm2/logs/CertiFriedUtility-error.log | tail -5`
Expected: no new error lines referencing these modules (an empty result is success).

---

## Notes for the implementer

- The `phishing_detections.source` column is `varchar(50)` and `matched_domain` is `varchar(255)` — the synthetic reason `image-scam (gambling+promo+money)` fits comfortably.
- `extractImageText` takes an iterable of attachments; `message.attachments` is a discord.js Collection, so pass `message.attachments.values()` (used in Task 4).
- The OCR worker is process-global and lazy; first OCR in the process pays ~1-2s init, subsequent ones are faster. This is acceptable because OCR only runs on image messages in phishing-enabled, non-exempt channels by non-trusted users.
- Do not add `tesseract.js` or `sharp` to `package.json` — both are already present.
