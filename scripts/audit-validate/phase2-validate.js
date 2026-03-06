/**
 * Phase 2: Cross-Reference & Validate
 * For each offender from phase 1:
 * 1. Resolve current username from Discord API
 * 2. Apply reason priority chain (image-reasons > content-derived > fallback)
 * 3. Validate/infer category
 * 4. Flag bad IDs (server IDs, invalid snowflakes, etc.)
 *
 * Output: audit-validated-YYYY-MM-DD.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { KNOWN_NON_USER_IDS, VALID_CATEGORIES } from './lib/constants.js';
import { isValidSnowflake, inferCategory, buildReasonFromContent } from './lib/classifier.js';
import { resolveUsernames } from './lib/resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');

/**
 * Load the image-reviewed reasons as a lookup by user_id.
 * Multiple entries per user_id are merged (best reason wins).
 */
function loadImageReasons() {
    try {
        const data = JSON.parse(readFileSync(join(PROJECT_ROOT, 'audit-image-reasons.json'), 'utf8'));
        const lookup = new Map();

        for (const entry of data.entries) {
            const existing = lookup.get(entry.user_id);
            // Keep the entry with the most detailed reason
            if (!existing || entry.reason.length > existing.reason.length) {
                lookup.set(entry.user_id, {
                    reason: entry.reason,
                    category: entry.category,
                    username: entry.username,
                    source: 'image_review',
                });
            }
        }

        console.log(`Loaded ${lookup.size} image-reviewed entries (from ${data.entries.length} total)`);
        return lookup;
    } catch (err) {
        console.warn('Could not load audit-image-reasons.json:', err.message);
        return new Map();
    }
}

/**
 * Determine the best reason and category for an offender.
 * Priority: image-reviewed > GFX channel default > content-derived > fallback
 */
function resolveReasonAndCategory(offender, imageReasons) {
    const userId = offender.user_id;

    // Priority 1: Image-reviewed reasons (highest trust)
    const imageEntry = imageReasons.get(userId);
    if (imageEntry) {
        return {
            reason: imageEntry.reason,
            category: imageEntry.category,
            reasonSource: 'image_review',
        };
    }

    // Combine all message content for analysis
    const combinedContent = offender.allContent.join(' ');

    // Priority 2: GFX spammer channel — default category "spam"
    const isGfxChannel = offender.channels.includes('1142508311594410086');
    if (isGfxChannel) {
        const reason = buildReasonFromContent(combinedContent, 'GFX spammer');
        return {
            reason: reason || 'GFX spammer reported in dedicated spam channel',
            category: 'spam',
            reasonSource: 'gfx_channel',
        };
    }

    // Priority 3: Red flags channel — analyze content for category
    const category = inferCategory(combinedContent);
    const reason = buildReasonFromContent(combinedContent, 'Various red flags');

    return {
        reason,
        category,
        reasonSource: 'content_derived',
    };
}

/**
 * Run phase 2: validate and enrich all offender entries.
 * @param {REST} rest - Discord REST client
 * @param {Array} offenders - Offenders from phase 1
 * @returns {Object} { validated, outputPath }
 */
export async function runPhase2(rest, offenders) {
    console.log('\n=== Phase 2: Cross-Reference & Validate ===\n');

    const imageReasons = loadImageReasons();

    // Separate valid offenders from flagged ones
    const valid = [];
    const flagged = [];

    for (const offender of offenders) {
        const userId = offender.user_id;

        // Check for known non-user IDs
        if (KNOWN_NON_USER_IDS.has(userId)) {
            flagged.push({
                user_id: userId,
                flag_reason: `Known non-user ID (server/channel/bot)`,
                flagged: true,
            });
            continue;
        }

        // Check for invalid snowflakes
        if (!isValidSnowflake(userId)) {
            flagged.push({
                user_id: userId,
                flag_reason: 'Invalid snowflake (timestamp before Discord epoch or invalid)',
                flagged: true,
            });
            continue;
        }

        valid.push(offender);
    }

    if (flagged.length > 0) {
        console.log(`Flagged ${flagged.length} bad IDs:`);
        for (const f of flagged) {
            console.log(`  ${f.user_id}: ${f.flag_reason}`);
        }
    }

    // Resolve usernames for valid offenders
    const userIds = valid.map(o => o.user_id);
    const usernames = await resolveUsernames(rest, userIds);

    // Build validated entries
    const validated = [];

    for (const offender of valid) {
        const { reason, category, reasonSource } = resolveReasonAndCategory(offender, imageReasons);
        const resolved = usernames.get(offender.user_id);
        const username = resolved?.display || 'Unknown';

        // Build Discord message links from report sources
        const SERVER_ID = '889550752123613194';
        const messageLinks = [...new Set(
            (offender.reports || []).map(r =>
                `https://discord.com/channels/${SERVER_ID}/${r.channelId}/${r.messageId}`
            )
        )];

        // Collect evidence: message links first, then image URLs
        const evidenceUrls = [
            ...messageLinks,
            ...new Set(offender.imageUrls || []),
        ];

        // Get primary reporter info (first reporter)
        const primaryReporter = offender.reports?.[0];
        const reporterName = primaryReporter?.authorName || offender.reporters?.[0] || null;
        const reporterId = primaryReporter?.authorId || null;

        validated.push({
            user_id: offender.user_id,
            username,
            resolvedUsername: resolved?.username || null,
            reason,
            category: VALID_CATEGORIES.includes(category) ? category : 'other',
            reasonSource,
            severity: 'high',
            evidence: evidenceUrls.length > 0 ? JSON.stringify(evidenceUrls) : null,
            reporter_id: reporterId,
            reporter_name: reporterName,
            reportCount: offender.reportCount,
            reporters: offender.reporters,
            channels: offender.channels,
            flagged: false,
        });
    }

    // Add flagged entries (marked so phase 3 can include them in the report)
    const allEntries = [...validated, ...flagged];

    // Stats
    const reasonSources = { image_review: 0, gfx_channel: 0, content_derived: 0 };
    for (const e of validated) {
        reasonSources[e.reasonSource]++;
    }

    console.log(`\nPhase 2 complete — ${validated.length} validated, ${flagged.length} flagged`);
    console.log(`Reason sources: image_review=${reasonSources.image_review}, gfx_channel=${reasonSources.gfx_channel}, content_derived=${reasonSources.content_derived}`);

    // Write output
    const date = new Date().toISOString().split('T')[0];
    const outputPath = join(PROJECT_ROOT, `audit-validated-${date}.json`);
    writeFileSync(outputPath, JSON.stringify({
        generated: new Date().toISOString(),
        stats: {
            validated: validated.length,
            flagged: flagged.length,
            reasonSources,
        },
        entries: allEntries,
    }, null, 2));

    console.log(`Output: ${outputPath}`);
    return { validated: allEntries, outputPath };
}
