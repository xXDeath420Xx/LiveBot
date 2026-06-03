# Image-Based Scam Detection — Design

**Date:** 2026-06-03
**Status:** Approved (design)

## Goal

Catch scam screenshots — e.g. the fake-MrBeast crypto-casino lure in `docs/scam.jpg`
(pushes `bozawin.com` + promo code `BOZA5600` + "giving away $5,600" inside the image) —
and **remove + action** them, **except** when posted in a reports / red-flags / evidence
channel. The scam payload lives *inside the image* (it is a phone photo of a screen), so the
existing text-only URL scanner never sees it.

## Approach

Extend the existing `core/phishing-detection-manager.js` rather than building a parallel
system. That manager already:
- deletes messages containing known phishing domains and applies `phishing_config.action`
  (mute/kick/ban/warn/delete),
- **exempts** reports/red-flags channels via `EVIDENCE_CHANNEL_PATTERNS`
  (`red-flag`, `report`, `scam-report`, `evidence`, …) in `isExemptChannel`,
- treats likely evidence posts gently (`looksLikeEvidencePost` → `forwardEvidencePost`),
- logs to `phishing_detections`, and alerts mods via `alert_channel_id`.

The only gap is that it scans `message.content` text. We add an **OCR pre-step** so text read
out of image attachments flows into that same pipeline. Detection decisions:

- **Breadth:** flag if the OCR'd text contains a **known phishing domain** (high confidence)
  **OR** matches a **scam-genre heuristic** (multi-signal). Genre detection catches new scams
  of this kind even when the domain is not yet blocklisted.
- **Action:** on a match outside an exempt channel, remove the message and apply the guild's
  existing `phishing_config.action` — same treatment as a known phishing link.

## Components

### 1. `core/scam-image-ocr.js` — image → text
`extractImageText(attachments)`:
- Filters to `contentType` `image/*`; caps at **≤2 images**, **≤8 MB** each (skip larger).
- Downloads via global `fetch` → `Buffer`.
- Preprocesses with **sharp**: grayscale → resize (upscale small to ~1500px wide, downscale
  huge) → contrast-normalize. Needed because the input is a *photo of a screen* (angle, glare),
  not a clean screenshot.
- OCR with **tesseract.js** through a **lazy singleton worker** guarded by an async mutex
  (one OCR job at a time → bounded memory), with an **8 s per-image timeout**.
- **Fail-open:** any download/preprocess/OCR error or timeout → returns `''`; never throws into
  the message pipeline.
- Exposes `terminateScamOcrWorker()` for graceful shutdown (optional wiring).

### 2. `core/scam-text-classifier.js` — text → verdict (pure)
`scoreScamText(text)` → `{ matched: boolean, groups: string[] }`.
Counts **distinct signal groups** present in the text:
- `gambling` — crypto casino, casino, bet/betting, slots, jackpot, gamble
- `giveaway` — giving away, giveaway, free $N, claim your reward/prize/bonus, airdrop,
  free nitro/crypto/btc/eth
- `promo` — promo code, bonus code, special code, use code, referral code
- `urgency` — will be deleted, don't miss, limited time, act now/fast, expires, one hour, hurry
- `money` — `$` followed by a 2+ digit amount (e.g. `$5,600`), or `N usd/btc/eth/sol`
- `lure` — withdraw … instant / instant … withdraw, deposit, register/sign-up … bonus

**Match = ≥3 distinct groups.** The sample image hits 5 (gambling + giveaway + money + promo +
urgency). A high bar keeps false positives low, which matters because the action is punitive.
Pure and deterministic → unit-tested. Also exports the group regex map for reuse/testing.

### 3. `core/phishing-detection-manager.js` — wiring (modify `checkMessage`)
New flow (preserves all existing text-URL behavior):
1. Skip bots/DMs/admins/owner/whitelisted (unchanged).
2. **Fast bail:** if the message has **no URL in text AND no image attachments**, return `false`
   (plain chat stays zero-cost).
3. Fetch `config` (cache-backed); return if disabled.
4. If `isExemptChannel` → return (reports/red-flags exemption).
5. If `config.scan_images` and image attachments present → `ocrText = await extractImageText(...)`.
6. `domains = extractDomains(content + "\n" + ocrText)` → existing blocklist check.
7. `genre = ocrText ? scoreScamText(ocrText) : { matched:false }` — **genre heuristic runs only
   on image-derived text**, so normal chat is never subject to it.
8. If a blocklisted domain matched **or** `genre.matched`:
   - `looksLikeEvidencePost(message)` → `forwardEvidencePost` (flag to reports, no punishment),
   - else `takeAction(message, reason, sourceUrl, config)` (delete + `config.action` + alert + log).

`takeAction` is generalized so the "matched domain" field accepts a synthetic reason
(`image-scam-genre`) when there is no domain; `source` recorded in `phishing_detections` is
`image-domain` or `image-genre`. The alert embed includes a short OCR snippet + the image link.

## Data / config

- **Migration 120** (`migrations/120_phishing_scan_images.js`): add
  `scan_images TINYINT(1) NOT NULL DEFAULT 1` to `phishing_config` (idempotent column check).
  Default-on for guilds already opted into phishing detection; per-guild toggle.
- **Logging:** reuse `phishing_detections` (`source` = `image-domain` | `image-genre`).

## Error handling & cost control

- OCR runs only when: phishing enabled · `scan_images` on · channel not exempt ·
  author not admin/owner/whitelisted · image present → rare.
- Serialized (singleton worker + mutex), per-image 8 s timeout, fail-open. A broken or huge
  image can never stall or crash the message handler.

## Testing

- **Unit** (`tests/scam-text-classifier.test.js`): `scoreScamText` on the `scam.jpg` wording
  (→ matched, groups ⊇ {gambling, giveaway, money, promo, urgency}); on benign text and a single
  casual "free giveaway" mention (→ not matched, <3 groups).
- **Integration proof (pre-deploy):** OCR the real `docs/scam.jpg` and confirm recovery of
  "casino / bozawin / promo code" and that `scoreScamText` flags it.

## Out of scope (YAGNI)

Perceptual image hashing of a known-bad library; automatic global-ban escalation; brand-name
hardcoding.
