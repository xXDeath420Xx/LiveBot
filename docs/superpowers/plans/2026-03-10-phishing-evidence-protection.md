# Phishing Evidence Protection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the phishing detection system from punishing users who share phishing screenshots/links as evidence in report channels or with report-style context.

**Architecture:** Three-layer filter (channel exemption → evidence heuristic → normal action) added to `PhishingDetectionManager.checkMessage()`. Shared report patterns extracted from `globalBanReportWatcher.js` into `utils/report-patterns.js`. New migration adds `exempt_channels` and `report_channel_id` columns to `phishing_config`.

**Tech Stack:** Node.js, Discord.js, MySQL, Express (dashboard API)

**Spec:** `docs/superpowers/specs/2026-03-10-phishing-evidence-protection-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `utils/report-patterns.js` | Create | Shared pattern lists used by phishing + ban watcher |
| `migrations/054_phishing_evidence_protection.js` | Create | Add `exempt_channels`, `report_channel_id` to `phishing_config` |
| `core/phishing-detection-manager.js` | Modify | Three-layer filter, evidence forwarding logic |
| `events/globalBanReportWatcher.js` | Modify | Import shared patterns instead of local copies |
| `dashboard/routes/api/features/phishing.js` | Create | GET/PUT API for phishing config including new fields |
| `dashboard/views/partials/manage/phishing.ejs` | Create | Dashboard UI for phishing config |

---

## Task 1: Create Shared Report Patterns Utility

**Files:**
- Create: `utils/report-patterns.js`

- [ ] **Step 1: Create `utils/report-patterns.js`**

```js
/**
 * Shared report/evidence pattern lists.
 * Used by phishing-detection-manager and globalBanReportWatcher.
 */

// General report signals — message is about reporting something
export const REPORT_PATTERNS = [
    /scam/i, /phish/i, /spam/i, /bot\b/i, /hack/i, /malware/i, /virus/i,
    /ban\b/i, /kick/i, /impersonat/i, /fraud/i, /fake/i,
    /friend request/i, /random.*request/i, /sus\b/i, /suspicious/i,
    /hijack/i, /compromis/i, /stole/i, /steal/i,
    /solicit/i, /advertis/i, /promot/i, /shill/i,
    /gfx\s*(art|spam|sell)/i, /artist.*spam/i,
    /link\s*spam/i, /mass\s*dm/i, /raid/i,
    /red\s*flag/i, /watch\s*(out|list)/i, /heads?\s*up/i,
    /User\s*ID:/i, /Discord\s*ID:/i, /App\s*ID:/i,
];

// Concrete, verifiable malicious behavior keywords
export const STRONG_EVIDENCE_PATTERNS = [
    /phish/i, /credential/i, /login\s*page/i, /fake\s*link/i, /token\s*grab/i,
    /nitro\s*(gift|free|scam)/i, /free\s*(nitro|steam|game)/i, /steam\s*gift/i,
    /scam/i, /fraud/i, /swindl/i, /pyramid\s*scheme/i, /ponzi/i,
    /mass\s*dm/i, /bulk\s*messag/i, /link\s*spam/i, /gfx\s*spam/i,
    /spam.*server/i, /server.*spam/i, /raid/i,
    /malware/i, /virus/i, /trojan/i, /keylog/i, /rat\b/i, /grabber/i,
    /ip\s*grab/i, /token\s*log/i, /hack/i,
    /impersonat/i,
    /bit\.ly/i, /tinyurl/i, /discord\.gift/i, /discocl/i, /discorcl/i,
    /steamcommunity[^.]/i, /store\.steampowered[^.]/i,
];

// Signals that a message is REPORTING a scam, not BEING one.
// Used by phishing detection to avoid punishing evidence posters.
export const EVIDENCE_POST_PATTERNS = [
    /watch\s*out/i, /heads?\s*up/i, /be\s*(careful|aware)/i, /warning/i,
    /caught\s*this/i, /found\s*this\s*(scam|phish|spam)/i,
    /this\s*(user|person|account)\s*(is|was)\s*(scam|phish|spam)/i,
    /report(ed|ing)?\s*(this|user|them)/i,
    /evidence[\s:]/i, /proof[\s:]/i, /screenshot[\s:]/i,
    /offender[\s:]/i, /reported\s*user[\s:]/i,
    /User\s*ID[\s:]/i, /Discord\s*ID[\s:]/i,
    /ban\s*(this|them|the)/i, /should\s*be\s*ban/i,
    /sending\s*(this|these)\s*(scam|phish|link)/i,
    /they('re|\s*are)\s*(sending|posting|spamming)/i,
    /don'?t\s*(click|open|trust)/i,
];

// Channel name substrings that auto-exempt from phishing actions
export const EVIDENCE_CHANNEL_PATTERNS = [
    'evidence', 'red-flag', 'report', 'scam-report', 'staff-report',
    'mod-log', 'mod-report', 'ban-appeal', 'ban-evidence',
];

// User ID regex (17-19 digit Discord snowflake)
export const USER_ID_REGEX = /\b\d{17,19}\b/;
```

- [ ] **Step 2: Commit**

```bash
git add utils/report-patterns.js
git commit -m "feat: extract shared report patterns into utility"
```

---

## Task 2: Update Ban Watcher to Use Shared Patterns

**Files:**
- Modify: `events/globalBanReportWatcher.js:55-79`

- [ ] **Step 1: Replace local pattern definitions with imports**

At the top of the file (after existing imports around line 10), add:

```js
import { REPORT_PATTERNS, STRONG_EVIDENCE_PATTERNS } from '../utils/report-patterns.js';
```

Delete the local `REPORT_PATTERNS` (lines 55-65) and `STRONG_EVIDENCE_PATTERNS` (lines 68-79) arrays.

- [ ] **Step 2: Verify no other references break**

Run: `grep -n 'REPORT_PATTERNS\|STRONG_EVIDENCE_PATTERNS' events/globalBanReportWatcher.js`

All remaining references should be usage, not definition. The imported names are identical so no call sites change.

- [ ] **Step 3: Commit**

```bash
git add events/globalBanReportWatcher.js
git commit -m "refactor: use shared report patterns in ban watcher"
```

---

## Task 3: Create Migration

**Files:**
- Create: `migrations/054_phishing_evidence_protection.js`

- [ ] **Step 1: Create the migration**

```js
/**
 * Migration 054: Phishing Evidence Protection
 *
 * Adds exempt_channels and report_channel_id to phishing_config
 * so the phishing system can distinguish evidence posts from scams.
 */
export async function up(pool) {
    await pool.execute(`
        ALTER TABLE phishing_config
        ADD COLUMN exempt_channels TEXT DEFAULT NULL
        COMMENT 'JSON array of channel IDs exempt from phishing detection'
    `);

    await pool.execute(`
        ALTER TABLE phishing_config
        ADD COLUMN report_channel_id VARCHAR(20) DEFAULT NULL
        COMMENT 'Channel to forward suspected evidence posts to'
    `);
}

export async function down(pool) {
    await pool.execute('ALTER TABLE phishing_config DROP COLUMN exempt_channels');
    await pool.execute('ALTER TABLE phishing_config DROP COLUMN report_channel_id');
}
```

- [ ] **Step 2: Run the migration**

```bash
node migrations/run.js 054
```

- [ ] **Step 3: Commit**

```bash
git add migrations/054_phishing_evidence_protection.js
git commit -m "feat: add phishing evidence protection columns"
```

---

## Task 4: Add Three-Layer Filter to Phishing Detection Manager

**Files:**
- Modify: `core/phishing-detection-manager.js`

This is the main change. The modifications go into three areas:

- [ ] **Step 1: Add imports at top of file**

After line 3 (`import configCache...`), add:

```js
import {
    REPORT_PATTERNS,
    EVIDENCE_POST_PATTERNS,
    EVIDENCE_CHANNEL_PATTERNS,
    USER_ID_REGEX
} from '../utils/report-patterns.js';
```

- [ ] **Step 2: Add `isExemptChannel()` method**

Add after `isWhitelisted()` (after line 97):

```js
    /**
     * Check if a channel is exempt from phishing detection.
     * Layer 1: explicit exempt list OR channel name pattern match.
     */
    isExemptChannel(channel, config) {
        // Check explicit exempt list
        if (config.exempt_channels) {
            try {
                const exemptList = JSON.parse(config.exempt_channels);
                if (Array.isArray(exemptList) && exemptList.includes(channel.id)) {
                    return true;
                }
            } catch {
                // Malformed JSON — skip
            }
        }

        // Check channel name against auto-exempt patterns
        const name = channel.name?.toLowerCase() || '';
        return EVIDENCE_CHANNEL_PATTERNS.some(pattern => name.includes(pattern));
    }
```

- [ ] **Step 3: Add `looksLikeEvidencePost()` method**

Add after `isExemptChannel()`:

```js
    /**
     * Check if a message looks like someone reporting/sharing evidence
     * rather than posting a scam. Layer 2 heuristic.
     * Returns true if ANY evidence signal matches (boolean, not scored).
     */
    looksLikeEvidencePost(message) {
        const content = message.content || '';

        // Signal 1: Message text matches evidence/report patterns
        if (EVIDENCE_POST_PATTERNS.some(p => p.test(content))) return true;
        if (REPORT_PATTERNS.some(p => p.test(content))) return true;

        // Signal 2: Contains a user ID + has image attachments (reporting with screenshot)
        const hasUserId = USER_ID_REGEX.test(content);
        const hasImages = message.attachments.some(a => a.contentType?.startsWith('image/'));
        if (hasUserId && hasImages) return true;

        // Signal 3: Author has mod/admin perms (staff sharing evidence)
        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isMod = message.member.permissions.has(PermissionFlagsBits.ModerateMembers);
            if (isAdmin || isMod) return true;
        }

        return false;
    }
```

- [ ] **Step 4: Add `forwardEvidencePost()` method**

Add after `looksLikeEvidencePost()`:

```js
    /**
     * Forward a suspected evidence post to the report channel and alert mods.
     * Deletes from original channel (still contains phishing link).
     */
    async forwardEvidencePost(message, matchedDomain, matchedUrl, config) {
        const { guild, author, channel } = message;

        // Capture attachment URLs before deletion (CDN links stay valid briefly)
        const attachmentUrls = message.attachments.map(a => a.url);
        const originalContent = message.content || '(no text content)';

        // Delete from original channel — still has a phishing link
        try {
            await message.delete();
        } catch (error) {
            logger.error('[PhishingDetection] Failed to delete evidence post', { error: error.message });
        }

        // Forward to report channel if configured
        if (config.report_channel_id) {
            try {
                const reportChannel = guild.channels.cache.get(config.report_channel_id);
                if (reportChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xF39C12) // Orange — needs review, not red
                        .setTitle('Possible Evidence Post Redirected')
                        .setDescription(
                            'This message was removed from its original channel because it contained a known phishing domain, ' +
                            'but it appears to be an evidence/report post. No action was taken against the user.'
                        )
                        .addFields(
                            { name: 'Author', value: `${author} (${author.tag})`, inline: true },
                            { name: 'Original Channel', value: `${channel}`, inline: true },
                            { name: 'Phishing Domain Found', value: `\`${matchedDomain}\``, inline: true },
                            { name: 'Original Message', value: originalContent.length > 1024 ? originalContent.substring(0, 1021) + '...' : originalContent, inline: false }
                        )
                        .setFooter({ text: `User ID: ${author.id} | Use this channel for evidence posts` })
                        .setTimestamp();

                    if (attachmentUrls.length > 0) {
                        embed.addFields({
                            name: 'Attachments',
                            value: attachmentUrls.map((url, i) => `[Attachment ${i + 1}](${url})`).join('\n'),
                            inline: false
                        });
                    }

                    await reportChannel.send({ embeds: [embed] });
                }
            } catch (error) {
                logger.error('[PhishingDetection] Failed to forward evidence post', { error: error.message });
            }
        }

        // Alert mods via the alert channel
        if (config.alert_channel_id) {
            try {
                const alertChannel = guild.channels.cache.get(config.alert_channel_id);
                if (alertChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xF39C12)
                        .setTitle('Phishing Detection — Evidence Post Flagged')
                        .setDescription(
                            `A message in ${channel} contained phishing domain \`${matchedDomain}\` but appeared to be an evidence/report post. ` +
                            `Message was deleted and ${config.report_channel_id ? 'forwarded to <#' + config.report_channel_id + '>' : 'not forwarded (no report channel configured)'}. ` +
                            'No action taken against the user.'
                        )
                        .addFields(
                            { name: 'User', value: `${author} (${author.tag})`, inline: true },
                            { name: 'Channel', value: `${channel}`, inline: true }
                        )
                        .setFooter({ text: `User ID: ${author.id}` })
                        .setTimestamp();

                    await alertChannel.send({ embeds: [embed] });
                }
            } catch (error) {
                logger.error('[PhishingDetection] Failed to send evidence alert', { error: error.message });
            }
        }

        // Log to phishing_detections
        if (config.log_detections) {
            try {
                await pool.execute(
                    `INSERT INTO phishing_detections (guild_id, user_id, channel_id, matched_domain, matched_url, source, action_taken)
                     VALUES (?, ?, ?, ?, ?, 'evidence_flagged', 'flagged_evidence')`,
                    [guild.id, author.id, channel.id, matchedDomain, matchedUrl]
                );
            } catch (error) {
                logger.error('[PhishingDetection] Failed to log evidence detection', { error: error.message });
            }
        }

        logger.info('[PhishingDetection] Evidence post flagged — no action against user', {
            guildId: guild.id,
            userId: author.id,
            domain: matchedDomain,
            channelId: channel.id
        });
    }
```

- [ ] **Step 5: Modify `checkMessage()` to use the three layers**

Replace the existing `checkMessage()` method (lines 104-132) with:

```js
    /**
     * Check a message for phishing links.
     * Three-layer filter: channel exemption → evidence heuristic → normal action.
     * @param {Message} message - Discord message to check
     * @returns {boolean} true if message was acted on
     */
    async checkMessage(message) {
        // Skip bots and DMs
        if (message.author.bot || !message.guild) return false;

        // Skip admins and owners
        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = message.member.id === message.guild.ownerId;
            if (isAdmin || isOwner) return false;
        }

        // Quick bail — no URLs in content
        const domains = this.extractDomains(message.content);
        if (domains.length === 0) return false;

        // Get guild config
        const config = await this.getConfig(message.guild.id);
        if (!config) return false;

        // Layer 1: Channel exemption — skip entirely
        if (this.isExemptChannel(message.channel, config)) return false;

        // Check each domain against the Set
        for (const { domain, url } of domains) {
            if (this.domainSet.has(domain) && !this.isWhitelisted(domain, config)) {
                // Layer 2: Evidence heuristic — flag instead of punish
                if (this.looksLikeEvidencePost(message)) {
                    await this.forwardEvidencePost(message, domain, url, config);
                    return true;
                }

                // Layer 3: Normal phishing action
                await this.takeAction(message, domain, url, config);
                return true;
            }
        }

        return false;
    }
```

- [ ] **Step 6: Commit**

```bash
git add core/phishing-detection-manager.js
git commit -m "feat: add three-layer evidence protection to phishing detection"
```

---

## Task 5: Dashboard API Route

**Files:**
- Create: `dashboard/routes/api/features/phishing.js`

- [ ] **Step 1: Create the API route**

Follow the pattern from `dashboard/routes/api/features/security.js`:

```js
/**
 * Phishing Detection API
 * GET/PUT config including exempt channels and report channel
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/phishing
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [config] = await pool.execute(
            'SELECT * FROM phishing_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                action: 'delete',
                mute_duration_minutes: 30,
                alert_channel_id: null,
                whitelist_domains: '[]',
                log_detections: true,
                exempt_channels: '[]',
                report_channel_id: null
            }
        });
    } catch (error) {
        logger.error('[API Phishing GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch phishing config' });
    }
});

/**
 * PUT /api/guilds/:guildId/phishing
 */
router.put('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            action,
            mute_duration_minutes,
            alert_channel_id,
            whitelist_domains,
            log_detections,
            exempt_channels,
            report_channel_id
        } = req.body;

        // Validate exempt_channels is valid JSON array if provided
        if (exempt_channels) {
            try {
                const parsed = JSON.parse(exempt_channels);
                if (!Array.isArray(parsed)) throw new Error('Not an array');
            } catch {
                return res.status(400).json({ error: 'exempt_channels must be a JSON array' });
            }
        }

        await pool.execute(`
            INSERT INTO phishing_config (guild_id, enabled, action, mute_duration_minutes, alert_channel_id, whitelist_domains, log_detections, exempt_channels, report_channel_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                action = VALUES(action),
                mute_duration_minutes = VALUES(mute_duration_minutes),
                alert_channel_id = VALUES(alert_channel_id),
                whitelist_domains = VALUES(whitelist_domains),
                log_detections = VALUES(log_detections),
                exempt_channels = VALUES(exempt_channels),
                report_channel_id = VALUES(report_channel_id)
        `, [
            guildId,
            enabled ? 1 : 0,
            action || 'delete',
            mute_duration_minutes || 30,
            alert_channel_id || null,
            whitelist_domains || '[]',
            log_detections ? 1 : 0,
            exempt_channels || '[]',
            report_channel_id || null
        ]);

        res.json({ success: true });
    } catch (error) {
        logger.error('[API Phishing PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update phishing config' });
    }
});

export default router;
```

- [ ] **Step 2: Register the route in the dashboard**

In `dashboard/routes/api/index.js` (or wherever feature API routes are mounted), add:

```js
import phishingRouter from './features/phishing.js';
router.use('/:guildId/phishing', phishingRouter);
```

Find the pattern by looking at how other feature routes like `security` are mounted.

- [ ] **Step 3: Commit**

```bash
git add dashboard/routes/api/features/phishing.js dashboard/routes/api/index.js
git commit -m "feat: add phishing config API with evidence protection fields"
```

---

## Task 6: Dashboard UI

**Files:**
- Create: `dashboard/views/partials/manage/phishing.ejs`
- Modify: Whichever parent view includes the manage partials

This task depends on the existing dashboard partial pattern. Check how other partials like `dashboard/views/partials/manage/moderation.ejs` are structured and included. The phishing partial needs:

- [ ] **Step 1: Create the phishing partial**

Add a section with:
- Toggle for `enabled`
- Dropdown for `action` (delete/warn/mute/kick/ban)
- Channel picker for `alert_channel_id`
- Channel picker for `report_channel_id` (new)
- Multi-select channel picker for `exempt_channels` (new)
- Text input for `whitelist_domains`
- Toggle for `log_detections`
- Mute duration input (shown when action=mute)

Follow the exact HTML/EJS structure used by the other manage partials in the codebase.

- [ ] **Step 2: Include the partial in the parent manage view**

Add the include in the same pattern as other feature sections.

- [ ] **Step 3: Commit**

```bash
git add dashboard/views/partials/manage/phishing.ejs [parent-view-file]
git commit -m "feat: add phishing config dashboard with evidence protection settings"
```

---

## Verification

After all tasks are complete:

1. Run the migration: `node migrations/run.js 054`
2. Restart the bot: `pm2 restart CertiFriedUtility`
3. Verify no startup errors in logs
4. Test Layer 1: Post a known phishing link in a channel named with "evidence" — should be ignored
5. Test Layer 2: Post a phishing link in #general with "watch out for this scam" — should be deleted, forwarded, and flagged (not banned)
6. Test Layer 3: Post a bare phishing link in #general with no report context — should be actioned normally
7. Dashboard: Verify the phishing config page loads and saves correctly
