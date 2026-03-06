/**
 * Channel Audit Script - AuditBot
 * Scrapes all messages from specified channels, extracts Discord IDs (17-19 digit numbers),
 * downloads evidence images to dashboard/public/evidence/, and generates an import-ready
 * JSON for the global bans system.
 *
 * Bot: 1478871238053990507
 * Server: 889550752123613194
 * Channels: 899865437267963924 (various red flags), 1142508311594410086 (GFX spammers)
 *
 * Usage: BOT_TOKEN="your_token" node scripts/audit-channels.js
 */

import { REST, Routes } from 'discord.js';
import { writeFileSync, mkdirSync, createWriteStream, existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const EVIDENCE_DIR = join(PROJECT_ROOT, 'dashboard', 'public', 'evidence');
const BASE_URL = 'https://certifriedmultitool.com/evidence';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('Missing BOT_TOKEN environment variable');
    console.error('Usage: BOT_TOKEN="your_token" node scripts/audit-channels.js');
    process.exit(1);
}

// Channel ID -> { category, label }
const CHANNELS = {
    '899865437267963924': { category: 'other', label: 'Various red flags' },
    '1142508311594410086': { category: 'spam', label: 'GFX spammer' }
};

const ID_REGEX = /\b\d{17,19}\b/g;
// Matches IDs embedded inside discord.com URLs (channel/message refs, not user reports)
const DISCORD_LINK_REGEX = /discord\.com\/channels\/\d{17,19}\/\d{17,19}(?:\/\d{17,19})?/g;
const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

// Known server/channel IDs that should never be treated as offender user IDs
const KNOWN_NON_USER_IDS = new Set([
    '889550752123613194',  // Server ID
    '899865437267963924',  // Channel: various red flags
    '1142508311594410086', // Channel: GFX spammers
]);

// Patterns that strongly indicate the message is REPORTING someone
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

// Patterns that suggest the author is TALKING TO or ABOUT someone (not reporting)
const CONVERSATION_PATTERNS = [
    /^(hey|hi|yo|sup|thanks|thank you|welcome|congrats)\b/i,
    /\b(check this out|look at this|have you seen)\b/i,
    /\b(I agree|good point|nice|lol|lmao)\b/i,
    /\b(my friend|my buddy|my alt)\b/i,
    /\b(helped me|thanks to|shoutout to|s\/o to)\b/i,
];

/**
 * Classify an extracted ID's intent within a message.
 * Returns: 'reported' | 'in_link' | 'is_author' | 'known_non_user' | 'conversation'
 *
 * Classification rules (in priority order):
 * 1. If the ID matches the message author -> 'is_author'
 * 2. If the ID appears inside a discord.com/channels/ URL -> 'in_link'
 * 3. If the ID is a known server/channel ID -> 'known_non_user'
 * 4. If content matches REPORT_PATTERNS -> 'reported' (reinforced confidence)
 * 5. If content matches CONVERSATION_PATTERNS and NOT report patterns -> 'conversation'
 * 6. Default -> 'reported' (these are report channels)
 */
function classifyId(id, content, authorId) {
    // Rule 1: Author's own ID
    if (id === authorId) return 'is_author';

    // Rule 2: ID is part of a Discord message/channel link
    const links = content.match(DISCORD_LINK_REGEX) || [];
    for (const link of links) {
        if (link.includes(id)) return 'in_link';
    }

    // Rule 3: Known server/channel IDs
    if (KNOWN_NON_USER_IDS.has(id)) return 'known_non_user';

    // Rule 4+5: Content pattern analysis
    const hasReportSignal = REPORT_PATTERNS.some(p => p.test(content));
    const hasConversationSignal = CONVERSATION_PATTERNS.some(p => p.test(content));

    // If conversation signals exist WITHOUT any report signals, flag it
    if (hasConversationSignal && !hasReportSignal) return 'conversation';

    // Rule 6: Default — report channels, so the ID is being reported
    return 'reported';
}

// Ensure evidence directory exists
mkdirSync(EVIDENCE_DIR, { recursive: true });

async function downloadImage(url, filename) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;

        const filePath = join(EVIDENCE_DIR, filename);
        const fileStream = createWriteStream(filePath);
        await pipeline(res.body, fileStream);

        return `${BASE_URL}/${filename}`;
    } catch (err) {
        console.error(`  Failed to download ${url}: ${err.message}`);
        return null;
    }
}

async function fetchAllMessages(channelId) {
    const allMessages = [];
    let lastId = null;
    let hasMore = true;
    let page = 0;

    console.log(`\n[Channel ${channelId}] Starting message fetch...`);

    while (hasMore) {
        const query = new URLSearchParams({ limit: '100' });
        if (lastId) query.set('before', lastId);

        const messages = await rest.get(Routes.channelMessages(channelId), { query });

        if (!messages.length) {
            hasMore = false;
            break;
        }

        for (const msg of messages) {
            const content = msg.content || '';
            const rawIds = content.match(ID_REGEX) || [];
            const imageAttachments = (msg.attachments || [])
                .filter(a => a.content_type?.startsWith('image/'));

            // Classify each extracted ID
            const classifiedIds = rawIds.map(id => ({
                id,
                intent: classifyId(id, content, msg.author.id)
            }));

            allMessages.push({
                messageId: msg.id,
                authorId: msg.author.id,
                author: `${msg.author.username}${msg.author.discriminator !== '0' ? '#' + msg.author.discriminator : ''} (${msg.author.id})`,
                authorName: msg.author.username,
                timestamp: msg.timestamp,
                content: content.slice(0, 200),
                fullContent: content,
                classifiedIds,
                extractedIds: classifiedIds.filter(c => c.intent === 'reported').map(c => c.id),
                skippedIds: classifiedIds.filter(c => c.intent !== 'reported'),
                imageAttachments
            });

            lastId = msg.id;
        }

        page++;
        if (page % 5 === 0) {
            console.log(`  ...fetched ${allMessages.length} messages so far`);
        }

        if (messages.length < 100) hasMore = false;
    }

    console.log(`[Channel ${channelId}] Done — ${allMessages.length} total messages`);
    return allMessages;
}

async function processChannel(channelId, config) {
    const messages = await fetchAllMessages(channelId);
    const results = [];

    // Classification stats
    const allClassified = messages.flatMap(m => m.classifiedIds);
    const intentCounts = { reported: 0, is_author: 0, in_link: 0, known_non_user: 0, conversation: 0 };
    for (const c of allClassified) intentCounts[c.intent]++;

    console.log(`[Channel ${channelId}] ID classification:`);
    console.log(`  reported (offenders):  ${intentCounts.reported}`);
    console.log(`  is_author (self-ref):  ${intentCounts.is_author}`);
    console.log(`  in_link (msg/ch ref):  ${intentCounts.in_link}`);
    console.log(`  known_non_user:        ${intentCounts.known_non_user}`);
    console.log(`  conversation (not rpt): ${intentCounts.conversation}`);

    // Log skipped IDs for transparency
    const skipped = messages.flatMap(m => m.skippedIds);
    if (skipped.length > 0) {
        console.log(`  Skipped IDs:`);
        for (const s of skipped) {
            console.log(`    ${s.id} -> ${s.intent}`);
        }
    }

    // Only process messages that have reported IDs (not just any IDs)
    const relevantMessages = messages.filter(m => m.extractedIds.length > 0);
    console.log(`[Channel ${channelId}] Downloading images for ${relevantMessages.length} messages with reported IDs...`);

    let downloaded = 0;
    let failed = 0;

    for (const msg of relevantMessages) {
        // Download images for this message
        const permanentUrls = [];
        for (let i = 0; i < msg.imageAttachments.length; i++) {
            const att = msg.imageAttachments[i];
            const ext = extname(att.filename) || '.png';
            const filename = `${msg.messageId}_${i}${ext}`;

            // Skip if already downloaded
            if (existsSync(join(EVIDENCE_DIR, filename))) {
                permanentUrls.push(`${BASE_URL}/${filename}`);
                downloaded++;
                continue;
            }

            const permanentUrl = await downloadImage(att.url, filename);
            if (permanentUrl) {
                permanentUrls.push(permanentUrl);
                downloaded++;
            } else {
                failed++;
            }
        }

        // Build result entries (one per offender ID)
        for (const offenderId of msg.extractedIds) {
            results.push({
                offenderId,
                messageId: msg.messageId,
                author: msg.author,
                authorName: msg.authorName,
                timestamp: msg.timestamp,
                content: msg.content,
                category: config.category,
                label: config.label,
                evidenceUrls: permanentUrls,
                hasEvidence: permanentUrls.length > 0
            });
        }
    }

    console.log(`  Images: ${downloaded} downloaded, ${failed} failed`);
    return results;
}

async function main() {
    console.log('Channel Audit Script — AuditBot');
    console.log('================================');

    const allResults = [];

    for (const [channelId, config] of Object.entries(CHANNELS)) {
        try {
            const results = await processChannel(channelId, config);
            allResults.push(...results);
        } catch (err) {
            console.error(`\nError auditing channel ${channelId}:`, err.message);
        }
    }

    // Deduplicate by offender ID (keep first occurrence with best evidence)
    const seen = new Map();
    for (const entry of allResults) {
        const existing = seen.get(entry.offenderId);
        if (!existing || (!existing.hasEvidence && entry.hasEvidence)) {
            seen.set(entry.offenderId, entry);
        }
    }

    const deduplicated = [...seen.values()];

    // Resolve usernames for all offender IDs
    console.log(`\nResolving usernames for ${deduplicated.length} offender IDs...`);
    const usernameCache = new Map();
    let resolved = 0;
    let unresolved = 0;

    for (let i = 0; i < deduplicated.length; i++) {
        const entry = deduplicated[i];
        if (usernameCache.has(entry.offenderId)) continue;

        try {
            const user = await rest.get(Routes.user(entry.offenderId));
            const displayName = user.global_name || user.username;
            usernameCache.set(entry.offenderId, `${displayName} (${user.username})`);
            resolved++;
        } catch {
            usernameCache.set(entry.offenderId, 'Unknown/Deleted User');
            unresolved++;
        }

        if ((i + 1) % 25 === 0) {
            console.log(`  ...resolved ${i + 1}/${deduplicated.length}`);
        }
    }
    console.log(`  Resolved: ${resolved}, Unknown/Deleted: ${unresolved}`);

    // Build import-ready JSON
    const importRows = deduplicated.map(entry => {
        const reporterId = entry.author.match(/\((\d{17,20})\)/)?.[1] || '';
        return {
            user_id: entry.offenderId,
            username: usernameCache.get(entry.offenderId) || 'Unknown',
            severity: 'high',
            category: entry.category,
            reason: `${entry.label} - reported by ${entry.authorName}`,
            reported_by: entry.authorName,
            reported_by_id: reporterId,
            evidence: entry.evidenceUrls.length
                ? entry.evidenceUrls.join(' | ')
                : 'No image evidence - message content: ' + entry.content.slice(0, 150)
        };
    });

    // Write import-ready JSON
    const importPath = join(PROJECT_ROOT, 'audit-import-ready.json');
    writeFileSync(importPath, JSON.stringify({ rows: importRows }, null, 2));

    // Write CSV for review
    const csvHeader = 'user_id,username,severity,category,reported_by,reported_by_id,reason,evidence';
    const csvRows = importRows.map(r =>
        [r.user_id, `"${r.username.replace(/"/g, '""')}"`, r.severity, r.category, `"${r.reported_by.replace(/"/g, '""')}"`, r.reported_by_id, `"${r.reason.replace(/"/g, '""')}"`, `"${r.evidence.replace(/"/g, '""')}"`].join(',')
    );
    writeFileSync(join(PROJECT_ROOT, 'audit-import-ready.csv'), csvHeader + '\n' + csvRows.join('\n'));

    // Summary
    const withEvidence = deduplicated.filter(e => e.hasEvidence).length;
    const withoutEvidence = deduplicated.filter(e => !e.hasEvidence).length;

    console.log('\n=== Final Summary ===');
    console.log(`  Unique offenders:        ${deduplicated.length}`);
    console.log(`  With image evidence:     ${withEvidence}`);
    console.log(`  Without image evidence:  ${withoutEvidence}`);
    console.log(`  Images saved to:         ${EVIDENCE_DIR}`);
    console.log(`  Import JSON:             ${importPath}`);
    console.log(`  Review CSV:              ${join(PROJECT_ROOT, 'audit-import-ready.csv')}`);
    console.log(`\nEvidence URLs use: ${BASE_URL}/`);
    console.log('Done.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
