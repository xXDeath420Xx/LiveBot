/**
 * Global Ban Report Watcher
 *
 * Connects a dedicated AuditBot client (separate from all CertiFried bots) to
 * guild 889550752123613194, where human moderators post reports containing
 * Discord user IDs + evidence in private channels. The AuditBot reads those
 * messages and creates/updates global ban entries in real-time.
 *
 * Requires AUDIT_BOT_TOKEN in .env — the token for bot 1478871238053990507.
 * If missing, the watcher is silently disabled.
 */

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { REPORT_PATTERNS } from '../utils/report-patterns.js';
import { mkdirSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const EVIDENCE_DIR = join(PROJECT_ROOT, 'dashboard', 'public', 'evidence');
const BASE_URL = 'https://certifriedmultitool.com/evidence';

// Watched channels: channelId -> { category, label }
const CHANNELS = {
    '899865437267963924': { category: 'other', label: 'Various red flags' },
    '1142508311594410086': { category: 'spam', label: 'GFX spammer' }
};

// Roles authorized to trigger ban entry creation (in the AuditBot guild)
const AUTHORIZED_ROLES = new Set([
    '889550893727494185',
    '1345811788020711626',
    '951075793109405696',
    '1345812273234579507',
    '995576900091138108'
]);

// ID extraction: bare IDs and mention formats (<@ID> and <@!ID>)
const ID_REGEX = /\b\d{17,19}\b/g;
const MENTION_REGEX = /<@!?(\d{17,19})>/g;
const DISCORD_LINK_REGEX = /discord\.com\/channels\/\d{17,19}\/\d{17,19}(?:\/\d{17,19})?/g;

// IDs that should never be treated as offender user IDs
const KNOWN_NON_USER_IDS = new Set([
    '889550752123613194',  // Server ID
    '899865437267963924',  // Channel: various red flags
    '1142508311594410086', // Channel: GFX spammers
    '1478871238053990507', // Audit bot
]);

// Watcher status exposed via global for dashboard API
function updateWatcherStatus(updates) {
    global.auditWatcherStatus = {
        ...(global.auditWatcherStatus || {}),
        ...updates
    };
}

const CONVERSATION_PATTERNS = [
    /^(hey|hi|yo|sup|thanks|thank you|welcome|congrats)\b/i,
    /\b(check this out|look at this|have you seen)\b/i,
    /\b(I agree|good point|nice|lol|lmao)\b/i,
    /\b(my friend|my buddy|my alt)\b/i,
    /\b(helped me|thanks to|shoutout to|s\/o to)\b/i,
];

// ─── Shared helpers ──────────────────────────────────────────

function classifyId(id, content, authorId) {
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

function inferCategory(channelId, content, offenderUsername = '') {
    if (channelId === '1142508311594410086') return 'spam';
    const searchText = `${content} ${offenderUsername}`;
    if (/phish/i.test(searchText)) return 'phishing';
    if (/scam/i.test(searchText)) return 'scam';
    if (/spam/i.test(searchText)) return 'spam';
    if (/harass/i.test(searchText)) return 'harassment';
    if (/\b(fake\s*link|steal|stole|credential|login\s*page)\b/i.test(searchText)) return 'phishing';
    if (/\b(fraud|rip\s*off|sketchy|swindl|decei)\b/i.test(searchText)) return 'scam';
    if (/\b(mass\s*dm|bulk\s*messag|advert|promot|shill|solicit)\b/i.test(searchText)) return 'spam';
    if (/\b(gfx|graphic\s*design|commission|pfp|banner\s*(art|design)|avatar\s*art|art\s*offer|digital\s*art(ist)?)\b/i.test(searchText)) return 'spam';
    if (/\b(unsolicited|cold\s*dm|random\s*dm|self[- ]?promo)\b/i.test(searchText)) return 'spam';
    if (/\b(bully|threat|stalk|abus|toxic)\b/i.test(searchText)) return 'harassment';
    if (/\b(impersonat|pretend|fake\s*(account|profile))\b/i.test(searchText)) return 'impersonation';
    if (/\b(raid|brigad)\b/i.test(searchText)) return 'raid';
    return 'other';
}

async function downloadEvidence(url, filename) {
    try {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const res = await fetch(url);
        if (!res.ok) return null;
        const filePath = join(EVIDENCE_DIR, filename);
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const { writeFileSync } = await import('fs');
        writeFileSync(filePath, buffer);
        return { url: `${BASE_URL}/${filename}`, localPath: filePath };
    } catch (err) {
        logger.error('[GlobalBanWatcher] Failed to download evidence', { url, error: err.message });
        return null;
    }
}

function extractIds(content) {
    const ids = new Set();
    for (const match of content.matchAll(ID_REGEX)) ids.add(match[0]);
    for (const match of content.matchAll(MENTION_REGEX)) ids.add(match[1]);
    return [...ids];
}

// ─── Core message processing ────────────────────────────────

async function processReportMessage(message) {
    // Skip bots and DMs
    if (message.author.bot || !message.guild) return;

    const channelConfig = CHANNELS[message.channel.id];
    if (!channelConfig) return;

    // Role gate with member fetch fallback
    let member = message.member;
    if (!member) {
        try {
            member = await message.guild.members.fetch(message.author.id);
        } catch {
            logger.warn('[GlobalBanWatcher] Could not fetch member', {
                userId: message.author.id, guildId: message.guild.id
            });
            return;
        }
    }

    const hasRole = member.roles.cache.some(role => AUTHORIZED_ROLES.has(role.id));
    if (!hasRole) return;

    const content = message.content;

    // Extract and classify IDs
    const allIds = extractIds(content);
    if (allIds.length === 0) return;

    const reportedIds = allIds.filter(
        id => classifyId(id, content, message.author.id) === 'reported'
    );
    if (reportedIds.length === 0) return;

    try {
        // Download evidence images
        const imageAttachments = [...message.attachments.values()].filter(
            a => a.contentType?.startsWith('image/')
        );
        const evidenceUrls = [];

        if (imageAttachments.length > 0) {
            mkdirSync(EVIDENCE_DIR, { recursive: true });
            let i = 0;
            for (const attachment of imageAttachments) {
                const ext = extname(attachment.name || '.png') || '.png';
                const filename = `${message.id}_${i}${ext}`;
                const result = await downloadEvidence(attachment.url, filename);
                if (result) evidenceUrls.push(result.url);
                i++;
            }
        }

        const evidenceJson = evidenceUrls.length > 0 ? JSON.stringify(evidenceUrls) : null;
        const reporterName = message.author.tag || message.author.username || message.author.id;

        // Build reason
        const strippedContent = content.replace(ID_REGEX, '').replace(MENTION_REGEX, '').trim();
        let reason;
        if (strippedContent.length > 5) {
            reason = `[${channelConfig.label}] ${content}`;
        } else {
            reason = `Reported in ${channelConfig.label} by ${message.author.tag} — see evidence images`;
        }

        // Use the main CertiFried globalBanManager for logging/cache if available
        const globalBanManager = global.botManager?.getDefaultClient?.()?.globalBanManager
            || message.client.globalBanManager;

        let processedCount = 0;

        for (const userId of reportedIds) {
            // Resolve username via the AuditBot client
            let username = userId;
            try {
                const user = await message.client.users.fetch(userId);
                username = user.tag || user.username || userId;
            } catch {
                // User may not exist or be fetchable
            }

            // Infer category per-offender (username may contain keywords like "GFX")
            const category = inferCategory(message.channel.id, content, username);

            // Deduplicate: check for existing active entry
            const [existing] = await pool.execute(
                'SELECT id, reason, evidence FROM global_ban_entries WHERE user_id = ? AND active = 1',
                [userId]
            );

            if (existing.length > 0) {
                const entry = existing[0];
                let mergedEvidence = entry.evidence;
                if (evidenceJson) {
                    const oldUrls = mergedEvidence ? JSON.parse(mergedEvidence) : [];
                    const newUrls = JSON.parse(evidenceJson);
                    const combined = [...new Set([...oldUrls, ...newUrls])];
                    mergedEvidence = JSON.stringify(combined);
                }

                const updatedReason = reason.length > (entry.reason || '').length ? reason : entry.reason;

                await pool.execute(
                    'UPDATE global_ban_entries SET reason = ?, evidence = ?, reporter_name = COALESCE(reporter_name, ?), updated_at = NOW() WHERE id = ?',
                    [updatedReason, mergedEvidence, reporterName, entry.id]
                );

                if (globalBanManager) {
                    await globalBanManager.logAction(
                        entry.id, message.guild.id, userId, 'entry_created',
                        message.author.id, `Updated from live report in ${channelConfig.label} (msg ${message.id})`
                    );
                }

                logger.info('[GlobalBanWatcher] Updated existing ban entry', {
                    entryId: entry.id, userId, channel: channelConfig.label
                });
            } else {
                const [result] = await pool.execute(
                    `INSERT INTO global_ban_entries (user_id, username, severity, category, reason, evidence, source, reporter_id, reporter_name, source_guild_id, verified, verification_votes)
                     VALUES (?, ?, 'high', ?, ?, ?, 'manual_report', ?, ?, ?, 1, 0)`,
                    [userId, username, category, reason, evidenceJson, message.author.id, reporterName, message.guild.id]
                );

                const entryId = result.insertId;

                if (globalBanManager) {
                    globalBanManager.banCache.set(userId, {
                        severity: 'high',
                        category,
                        entryId
                    });

                    await globalBanManager.logAction(
                        entryId, message.guild.id, userId, 'entry_created',
                        message.author.id, `Live report from ${channelConfig.label} (msg ${message.id})`
                    );
                }

                logger.info('[GlobalBanWatcher] Created new ban entry', {
                    entryId, userId, username, category, channel: channelConfig.label
                });
            }

            processedCount++;
            updateWatcherStatus({
                lastProcessed: new Date().toISOString(),
                processedCount: (global.auditWatcherStatus?.processedCount || 0) + 1
            });
        }

        // React with checkmark to confirm processing
        if (processedCount > 0) {
            await message.react('\u2705').catch(() => {});
        }

    } catch (error) {
        logger.error('[GlobalBanWatcher] Error processing report message', {
            error: error.message,
            messageId: message.id,
            channelId: message.channel.id,
            authorId: message.author.id
        });
    }
}

// ─── Catch-up: process missed messages on startup ────────────

async function catchUpMessages(auditClient, limit = 50) {
    for (const [channelId, config] of Object.entries(CHANNELS)) {
        try {
            const channel = await auditClient.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                logger.warn('[GlobalBanWatcher] Catch-up: cannot access channel', { channelId, label: config.label });
                continue;
            }

            const messages = await channel.messages.fetch({ limit });
            let processed = 0;

            for (const msg of messages.values()) {
                if (msg.author.bot) continue;

                // Skip messages already reacted to with ✅
                const checkReaction = msg.reactions.cache.find(r => r.emoji.name === '✅');
                if (checkReaction && checkReaction.me) continue;

                await processReportMessage(msg);
                processed++;
            }

            logger.info(`[GlobalBanWatcher] Catch-up complete for ${config.label}`, {
                channelId, checked: messages.size, processed
            });
        } catch (err) {
            logger.error(`[GlobalBanWatcher] Catch-up failed for ${config.label}`, {
                channelId, error: err.message
            });
        }
    }
}

// ─── Public API ──────────────────────────────────────────────

let auditClient = null;

/**
 * Start the AuditBot watcher. Creates a lightweight Discord client using
 * AUDIT_BOT_TOKEN, connects to the gateway, and listens for new messages
 * in the watched channels. Also runs a catch-up scan on startup.
 */
export async function startAuditWatcher() {
    const token = process.env.AUDIT_BOT_TOKEN;
    if (!token) {
        logger.warn('[GlobalBanWatcher] No AUDIT_BOT_TOKEN in .env — live watcher disabled');
        return null;
    }

    auditClient = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Message, Partials.GuildMember],
    });

    auditClient.on('messageCreate', processReportMessage);

    auditClient.once('ready', async () => {
        logger.info(`[GlobalBanWatcher] Audit bot connected as ${auditClient.user.tag}`);
        logger.info(`[GlobalBanWatcher] Watching ${Object.keys(CHANNELS).length} channels for live reports`);

        updateWatcherStatus({
            connected: true,
            botTag: auditClient.user.tag,
            channelsWatched: Object.keys(CHANNELS).length,
            processedCount: 0
        });

        // Catch up on messages missed during downtime
        try {
            await catchUpMessages(auditClient);
        } catch (err) {
            logger.error('[GlobalBanWatcher] Catch-up error', { error: err.message });
        }
    });

    await auditClient.login(token);
    return auditClient;
}

/**
 * Export for the one-time processing script.
 * Allows external callers to process a message through the same logic.
 */
export { processReportMessage, catchUpMessages, CHANNELS };

// Not a standard event handler — started via startAuditWatcher() from index.js.
// loadEvents() checks for .name and .execute; this object has neither, so it's skipped.
export default {};
