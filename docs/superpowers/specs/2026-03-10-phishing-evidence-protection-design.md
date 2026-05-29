# Phishing Evidence Protection

## Problem

The phishing detection system can't distinguish between someone posting a scam and someone sharing evidence of a scam. A user posting phishing screenshots in an evidence/report channel — or even in #general with "watch out for this scammer" context — gets treated the same as the scammer themselves.

## Solution

Three-layer filter added to `PhishingDetectionManager.checkMessage()`, plus shared report patterns extracted into a utility.

## Components

### 1. Shared Report Patterns (`utils/report-patterns.js`)

Extracts patterns currently hardcoded in `globalBanReportWatcher.js` into a shared utility:

- `REPORT_PATTERNS` — general report signals: scam, phish, ban, suspicious, "User ID:", etc.
- `STRONG_EVIDENCE_PATTERNS` — concrete malicious behavior keywords: token grab, mass dm, malware, etc.
- `EVIDENCE_POST_PATTERNS` — phishing-specific signals that a message is *reporting* not *being* a scam: "watch out", "caught this", "found this scammer", "evidence:", "offender:", user ID + image attachment combo, message starts with mention/ID + descriptive text
- `EVIDENCE_CHANNEL_PATTERNS` — substring list for auto-exempting channels by name: `evidence`, `red-flag`, `report`, `scam-report`, `staff-report`, `mod-log`, `mod-report`, `ban-appeal`, `ban-evidence`

`globalBanReportWatcher.js` imports `REPORT_PATTERNS` and `STRONG_EVIDENCE_PATTERNS` from this utility instead of defining its own. No behavior change.

### 2. Migration: New Columns on `phishing_config`

| Column | Type | Purpose |
|--------|------|---------|
| `exempt_channels` | `TEXT` | JSON array of channel IDs never actioned |
| `report_channel_id` | `VARCHAR(20)` | Channel to forward suspected evidence posts to |

### 3. Three-Layer Filter in `checkMessage()`

**Layer 1 — Channel Exemption (fast bail):**
- Channel ID in `config.exempt_channels` → skip entirely
- Channel name substring-matches `EVIDENCE_CHANNEL_PATTERNS` → skip entirely

**Layer 2 — Evidence Heuristic (before taking action):**
Only runs when a phishing domain IS matched. Checks:
- Message matches any `EVIDENCE_POST_PATTERNS` or `REPORT_PATTERNS`
- Structural signals: contains a user ID (17-19 digits) + image attachments, starts with "User ID:"/mention + descriptive text, author has mod/admin perms

If any evidence signal matches:
- Delete from original channel (still contains a phishing link)
- Forward to `report_channel_id` if configured (embed with original author, content, attachments, redirect explanation)
- Post to `alert_channel_id`: possible evidence post, forwarded for mod review, no action taken against user
- Log to `phishing_detections` with `action_taken = 'flagged_evidence'`
- Do NOT ban/mute/kick the poster

**Layer 3 — Normal Phishing Action:**
Existing `takeAction()` flow unchanged — delete/warn/mute/kick/ban as configured.

### 4. Dashboard Updates

Two new fields on the phishing config page:
- Multi-select channel picker for `exempt_channels`
- Single channel picker for `report_channel_id`

Both optional. Auto-exempt by channel name works with zero config.

### 5. Forward Embed

When a suspected evidence post is forwarded to `report_channel_id`, an embed includes: original author, original channel, matched phishing domain, original message content, attachment URLs, and explanation that the message was redirected and no action was taken.

## Files Changed

| File | Change |
|------|--------|
| `utils/report-patterns.js` | **New** — shared pattern lists |
| `migrations/054_phishing_evidence_protection.js` | **New** — adds `exempt_channels`, `report_channel_id` to `phishing_config` |
| `core/phishing-detection-manager.js` | Three-layer filter in `checkMessage()`, forward logic |
| `events/globalBanReportWatcher.js` | Import shared patterns instead of local copies |
| `dashboard/views/partials/manage/phishing.ejs` | New channel pickers (if phishing dashboard exists) |
| `dashboard/routes/api/features/phishing.js` | API for new config fields (if phishing API exists) |

## Design Decisions

- **Boolean evidence detection, not scored** — any signal flags for review. Safe default: don't punish someone who might be helping.
- **Shared patterns, not shared classifier** — YAGNI on a full evidence classifier middleware until a third system needs it.
- **Substring channel matching** — Discord channels are hyphen-delimited by convention; substring is simple and sufficient.
- **Delete-then-forward** — even evidence posts with real phishing links should be removed from non-evidence channels. The forward preserves the content for mods.
