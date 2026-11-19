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

import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import AdaptiveSpamManager from '../core/adaptive-spam-manager.js';
import { REPORT_PATTERNS } from '../utils/report-patterns.js';
import { mkdirSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const EVIDENCE_DIR = join(PROJECT_ROOT, 'dashboard', 'public', 'evidence');
const BASE_URL = 'https://certifriedmultitool.com/evidence';

// Watched channels and authorised reporter roles live in audit_watch_channels / audit_watch_roles
// (migration 414) and are edited on the dashboard (dashboard/routes/audit-bot.js). These constants
// are what the code held before, used only when those tables cannot be read at all.
// category: 'auto' = inferCategory() works it out from the report, anything else is fixed.
const CHANNELS = {
    '899865437267963924': { category: 'auto', label: 'Various red flags' },
    '1142508311594410086': { category: 'spam', label: 'GFX spammer' }
};

const AUTHORIZED_ROLES = new Set([
    '889550893727494185',
    '1345811788020711626',
    '951075793109405696',
    '1345812273234579507',
    '995576900091138108'
]);

const CONFIG_TTL_MS = 60 * 1000;
let liveConfig = null; // { channels: {id: {category,label,guildId}}, roles: Set, loadedAt }

/**
 * Current watcher settings. Reads the DB at most once a minute; the dashboard calls
 * invalidateWatcherConfig() after a save so a change applies to the next message.
 * An empty table is respected (nothing watched / nobody authorised); only a failed read
 * falls back — to the last good settings, or to the constants above if there are none yet.
 */
export async function loadWatcherConfig({ force = false } = {}) {
    if (!force && liveConfig && Date.now() - liveConfig.loadedAt < CONFIG_TTL_MS) return liveConfig;
    try {
        const [chRows] = await pool.query('SELECT guild_id, channel_id, category, label FROM audit_watch_channels WHERE enabled = 1');
        const [roRows] = await pool.query('SELECT role_id FROM audit_watch_roles');
        const channels = {};
        for (const r of chRows) channels[r.channel_id] = { category: r.category || 'auto', label: r.label || r.channel_id, guildId: r.guild_id };
        liveConfig = { channels, roles: new Set(roRows.map(r => r.role_id)), loadedAt: Date.now(), source: 'db' };
    } catch (err) {
        logger.warn('[GlobalBanWatcher] Could not read watcher settings - using last known', { error: err.message });
        liveConfig = liveConfig
            ? { ...liveConfig, loadedAt: Date.now() }
            : { channels: { ...CHANNELS }, roles: new Set(AUTHORIZED_ROLES), loadedAt: Date.now(), source: 'fallback' };
    }
    return liveConfig;
}

export function invalidateWatcherConfig() { liveConfig = null; }

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
    if (KNOWN_NON_USER_IDS.has(id) || (liveConfig && liveConfig.channels[id])) return 'known_non_user';
    const hasReportSignal = REPORT_PATTERNS.some(p => p.test(content));
    const hasConversationSignal = CONVERSATION_PATTERNS.some(p => p.test(content));
    if (hasConversationSignal && !hasReportSignal) return 'conversation';
    return 'reported';
}

function inferCategory(channelCategory, content, offenderUsername = '') {
    if (channelCategory && channelCategory !== 'auto') return channelCategory;
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

    const watch = await loadWatcherConfig();
    const channelConfig = watch.channels[message.channel.id];
    if (!channelConfig) return;

    // Role gate with member fetch fallback
    let member = message.member;
    if (!member) {
        try {
            member = await message.guild.members.fetch(message.author.id);
        } catch (error) {
            // 10007 Unknown Member: the reporter has left, so their role can't be checked and the report
            // is skipped. Expected for old messages, which catch-up re-reads on every boot.
            const log = error?.code === 10007 ? logger.debug : logger.warn;
            log.call(logger, '[GlobalBanWatcher] Could not fetch member', {
                userId: message.author.id, guildId: message.guild.id, code: error?.code
            });
            return;
        }
    }

    const hasRole = member.roles.cache.some(role => watch.roles.has(role.id));
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
            const category = inferCategory(channelConfig.category, content, username);

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
    const watch = await loadWatcherConfig({ force: true });
    for (const [channelId, config] of Object.entries(watch.channels)) {
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

// ─── Adaptive anti-spam ──────────────────────────────────────

/**
 * Files a spammer the adaptive filter just banned into the global ban tracker.
 *
 * Wired in as AdaptiveSpamManager#onSpamConfirmed below, so it only ever runs for AuditBot — the
 * other guilds running adaptive spam detection never touch the tracker. Mirrors the dedupe/merge
 * behaviour of processReportMessage(): an existing active entry is updated rather than duplicated.
 *
 * `source` is 'system' (not 'manual_report') so an automated catch is always distinguishable from a
 * human-filed report in the audit trail.
 */
async function fileGlobalBanForSpammer(message, config, spamScore) {
    const { guild, author } = message;
    const userId = author.id;
    const username = author.tag || author.username || userId;

    // The cross-channel row is the evidence: which channels, and a preview of the repeated content.
    const [hits] = await pool.execute(
        `SELECT channel_count, message_preview FROM cross_channel_spam
         WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`,
        [guild.id, userId]
    );
    const hit = hits[0];
    const preview = (hit?.message_preview || message.content || '').slice(0, 300);
    const spread = hit?.channel_count
        ? `${hit.channel_count} channels`
        : `${config.cross_channel_threshold || 3}+ channels`;

    const reason = `[Adaptive spam filter] Posted identical content across ${spread} `
        + `within ${config.cross_channel_timeframe_minutes || 5} minutes (score ${Math.round(spamScore)}). `
        + `Auto-banned in ${guild.name}.${preview ? ` Content: "${preview}"` : ''}`;

    const globalBanManager = global.botManager?.getDefaultClient?.()?.globalBanManager;
    const reporterId = message.client.user?.id || null;
    const reporterName = 'AuditBot (adaptive spam filter)';

    const [existing] = await pool.execute(
        'SELECT id FROM global_ban_entries WHERE user_id = ? AND active = 1',
        [userId]
    );

    if (existing.length > 0) {
        await pool.execute(
            'UPDATE global_ban_entries SET reason = ?, reporter_name = COALESCE(reporter_name, ?), updated_at = NOW() WHERE id = ?',
            [reason, reporterName, existing[0].id]
        );
        logger.info('[GlobalBanWatcher] Adaptive spam updated existing ban entry', {
            entryId: existing[0].id, userId, username
        });
        return;
    }

    const [result] = await pool.execute(
        `INSERT INTO global_ban_entries (user_id, username, severity, category, reason, evidence, source, reporter_id, reporter_name, source_guild_id, verified, verification_votes)
         VALUES (?, ?, 'high', 'spam', ?, NULL, 'system', ?, ?, ?, 1, 0)`,
        [userId, username, reason, reporterId, reporterName, guild.id]
    );

    const entryId = result.insertId;

    if (globalBanManager) {
        globalBanManager.banCache.set(userId, { severity: 'high', category: 'spam', entryId });
        await globalBanManager.logAction(
            entryId, guild.id, userId, 'entry_created', reporterId,
            `Adaptive spam filter auto-ban (score ${Math.round(spamScore)}, ${spread})`
        );
    }

    logger.warn('[GlobalBanWatcher] Adaptive spam filed new global ban entry', {
        entryId, userId, username, spamScore: Math.round(spamScore), spread
    });
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

    // Bring AuditBot into the CertiFried manager stack. It cannot be registered in `custom_bots` —
    // bot-manager would log this same token in a SECOND time and every message would be processed
    // twice (double bans, double tracker entries) — so the managers are attached to the client it
    // already has. Gated entirely on an enabled adaptive_spam_config row, so it stays inert in any
    // guild that has not opted in.
    // Dashboard-only registration: core/bot-manager.js keeps auxiliary bots out of `clients`,
    // so no event loader, command deploy or guild count ever picks this client up.
    global.botManager?.registerAuxiliaryClient?.('audit', auditClient, { label: 'Audit bot', page: 'audit-bot' });

    const spamManager = new AdaptiveSpamManager(auditClient);
    spamManager.onSpamConfirmed = fileGlobalBanForSpammer;
    auditClient.adaptiveSpamManager = spamManager;

    auditClient.on('messageCreate', async (message) => {
        await processReportMessage(message);

        // analyzeMessage() filters neither bots nor DMs itself — the main bot's messageCreate does
        // that upstream before calling it — so both guards have to live here.
        if (message.author?.bot || !message.guild) return;
        try {
            await spamManager.analyzeMessage(message);
        } catch (err) {
            logger.error('[GlobalBanWatcher] Adaptive spam analysis failed', {
                error: err.message, messageId: message.id, guildId: message.guild.id
            });
        }
    });

    // The spam alert embed carries "False Positive" / "Reset Profile" buttons. handleButtonInteraction
    // parses any customId it is handed, so only give it the ones that are actually its own.
    auditClient.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton?.() || !interaction.customId?.startsWith('adaptivespam_')) return;
        try {
            await spamManager.handleButtonInteraction(interaction);
        } catch (err) {
            logger.error('[GlobalBanWatcher] Adaptive spam button failed', { error: err.message });
        }
    });

    auditClient.once(Events.ClientReady, async () => {
        logger.info(`[GlobalBanWatcher] Audit bot connected as ${auditClient.user.tag}`);
        const watchNow = await loadWatcherConfig({ force: true });
        logger.info(`[GlobalBanWatcher] Watching ${Object.keys(watchNow.channels).length} channels for live reports`);

        updateWatcherStatus({
            connected: true,
            connectedAt: new Date().toISOString(),
            botTag: auditClient.user.tag,
            channelsWatched: Object.keys(watchNow.channels).length,
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
// loadEvents() skips modules marked notAnEvent instead of warning once per bot on every boot.
export default { notAnEvent: true };
