/**
 * Improved ID classifier for audit channel messages.
 * Enhances the original audit-channels.js classifyId with:
 * - Snowflake timestamp validation (rejects IDs before Discord epoch)
 * - Expanded KNOWN_NON_USER_IDS (server ID, bot ID)
 * - Explicit 'invalid_snowflake' classification
 */

import { KNOWN_NON_USER_IDS, DISCORD_EPOCH } from './constants.js';

const ID_REGEX = /\b\d{17,19}\b/g;
const DISCORD_LINK_REGEX = /discord\.com\/channels\/\d{17,19}\/\d{17,19}(?:\/\d{17,19})?/g;


const REPORT_PATTERNS = [
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

const CONVERSATION_PATTERNS = [
    /^(hey|hi|yo|sup|thanks|thank you|welcome|congrats)\b/i,
    /\b(check this out|look at this|have you seen)\b/i,
    /\b(I agree|good point|nice|lol|lmao)\b/i,
    /\b(my friend|my buddy|my alt)\b/i,
    /\b(helped me|thanks to|shoutout to|s\/o to)\b/i,
];

/**
 * Validate that a snowflake ID was created after the Discord epoch.
 * Discord snowflakes encode a timestamp in the high bits.
 */
export function isValidSnowflake(id) {
    try {
        const snowflake = BigInt(id);
        const timestamp = (snowflake >> 22n) + DISCORD_EPOCH;
        const now = BigInt(Date.now());
        // Must be after Discord epoch and not in the future (with 1-day buffer)
        return timestamp >= DISCORD_EPOCH && timestamp <= now + 86400000n;
    } catch {
        return false;
    }
}

/**
 * Classify an extracted ID's intent within a message.
 * Returns: 'reported' | 'in_link' | 'is_author' | 'known_non_user' | 'conversation' | 'invalid_snowflake'
 */
export function classifyId(id, content, authorId) {
    if (!isValidSnowflake(id)) return 'invalid_snowflake';
    if (id === authorId) return 'is_author';

    const links = content.match(DISCORD_LINK_REGEX) || [];
    for (const link of links) {
        if (link.includes(id)) return 'in_link';
    }

    if (KNOWN_NON_USER_IDS.has(id)) return 'known_non_user';

    const hasReportSignal = REPORT_PATTERNS.some(p => p.test(content));
    const hasConversationSignal = CONVERSATION_PATTERNS.some(p => p.test(content));

    if (hasConversationSignal && !hasReportSignal) return 'conversation';

    return 'reported';
}

/**
 * Extract and classify all IDs from a message.
 *
 * Key improvement: when a message contains explicit labels like "User ID: 123",
 * the labeled ID is the actual offender. Any mention IDs in the same message
 * are demoted to 'mention_context' since they're often just people being discussed,
 * not the offender being reported.
 *
 * Returns { classifiedIds, reportedIds, skippedIds }
 */
export function extractAndClassifyIds(content, authorId) {
    // Step 1: Extract explicitly labeled IDs (highest confidence offender signal)
    const labeledIds = new Set();
    const labelRegex = /(?:U[sd]er|Discord|App|Offender|Banned?)\s*(?:ID)?[:\s]+(\d{17,19})/gi;
    let labelMatch;
    while ((labelMatch = labelRegex.exec(content)) !== null) {
        labeledIds.add(labelMatch[1]);
    }

    // Step 2: Extract mention IDs
    const mentionIds = new Set();
    const mentionRegex = /<@!?(\d{17,19})>/g;
    let mentionMatch;
    while ((mentionMatch = mentionRegex.exec(content)) !== null) {
        mentionIds.add(mentionMatch[1]);
    }

    // Step 3: Detect cross-reference messages (primarily a Discord link + mention, no real report content)
    // e.g. "https://discord.com/channels/.../1146184430776492082 \nFor the sake of one <@534127>"
    const links = content.match(DISCORD_LINK_REGEX) || [];
    const contentWithoutLinksAndMentions = content
        .replace(/https?:\/\/\S+/g, '')
        .replace(/<@!?\d+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const isCrossReference = links.length > 0 && contentWithoutLinksAndMentions.length < 50;

    // Step 4: Extract all raw IDs
    const rawIds = content.match(ID_REGEX) || [];

    // Step 5: Classify with labeled ID priority
    const hasLabeledIds = labeledIds.size > 0;

    const classifiedIds = rawIds.map(id => {
        // If this ID was explicitly labeled (User ID: X), it's the offender
        if (labeledIds.has(id)) {
            const base = classifyId(id, content, authorId);
            // Override to 'reported' unless it's genuinely invalid/known-non-user
            if (base === 'invalid_snowflake' || base === 'known_non_user') {
                return { id, intent: base };
            }
            return { id, intent: 'reported' };
        }

        // If labeled IDs exist and this is a mention, demote it
        if (hasLabeledIds && mentionIds.has(id)) {
            return { id, intent: 'mention_context' };
        }

        // If this is a cross-reference message, demote all mentions
        // (the message is just linking to the real report elsewhere)
        if (isCrossReference && mentionIds.has(id)) {
            return { id, intent: 'cross_reference' };
        }

        return { id, intent: classifyId(id, content, authorId) };
    });

    return {
        classifiedIds,
        reportedIds: classifiedIds.filter(c => c.intent === 'reported').map(c => c.id),
        skippedIds: classifiedIds.filter(c => c.intent !== 'reported')
    };
}

/**
 * Infer a category from message content when the default is 'other'.
 */
export function inferCategory(content) {
    const lower = content.toLowerCase();
    if (/scam|phish|steal|stole|fraud|fake\s*(nitro|giveaway)|free\s*nitro|login|credential|token\s*(grab|log|steal)|crypto|account\s*sell/i.test(lower)) return 'scam';
    if (/spam|gfx|mass\s*dm|advertis|promo|shill|unsolicited|nsfw/i.test(lower)) return 'spam';
    if (/raid|nuke|mass\s*ban|mass\s*kick/i.test(lower)) return 'raid';
    if (/harass|threat|bully|stalk|doxx/i.test(lower)) return 'harassment';
    if (/selfbot|self\s*bot|auto\s*mod/i.test(lower)) return 'selfbot';
    if (/impersonat|pretend|pose\s*as/i.test(lower)) return 'impersonation';
    return 'other';
}

/**
 * Build a content-derived reason from message text (replaces generic placeholders).
 */
export function buildReasonFromContent(content, channelLabel) {
    // Clean up the content: remove Discord formatting, excess whitespace
    let cleaned = content
        .replace(/<@!?\d+>/g, '')       // Remove user mentions
        .replace(/<#\d+>/g, '')          // Remove channel mentions
        .replace(/<:\w+:\d+>/g, '')      // Remove custom emojis
        .replace(/https?:\/\/\S+/g, '')  // Remove URLs
        .replace(/`/g, '')              // Remove backticks
        .replace(/\s+/g, ' ')
        .trim();

    // Fix known typos
    cleaned = cleaned.replace(/\bUder\b/g, 'User');

    // Strip out bare snowflake IDs and ID labels — these aren't useful as reasons
    cleaned = cleaned
        .replace(/(?:User|Discord|App)\s*ID:\s*\d{17,19}/gi, '')
        .replace(/\b\d{17,19}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (cleaned.length > 200) {
        cleaned = cleaned.slice(0, 197) + '...';
    }

    if (cleaned.length < 10) {
        // Content was just IDs/links — no meaningful reason available
        return null;
    }

    return cleaned;
}
