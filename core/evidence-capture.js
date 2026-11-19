/*
 * Deleted-image evidence.
 *
 * message_logs has always stored attachment_urls, but the delete log never showed them, and
 * they would not have helped: Discord CDN links are signed for about a day and stop working once
 * the message is deleted. A moderator looking at "Message deleted" saw text only — the image
 * that got someone reported was gone.
 *
 * With the per-guild switch on (logging_config.evidence_capture_enabled, dashboard card
 * "Deleted-image evidence", migration 285):
 *
 *   capture  (message created) utils/message-cache.js records each attachment in
 *            message_attachments and, for images under the size limit, downloads a private copy
 *            into data/evidence-cache/<guild>/ (not web-served). The copy is what makes evidence
 *            possible for a message deleted hours later, after its CDN link has expired.
 *   delete   core/log-manager.js (single) and events/messageDeleteBulk.js (bulk) call in here:
 *            each image is re-uploaded to the evidence channel (or, if none is set, the
 *            message-delete log channel), and the new attachment URL plus the evidence message
 *            id are stored on the message_attachments row. The local copy is then removed.
 *
 * Copies of images that are never deleted expire from the local cache after
 * EVIDENCE_CACHE_TTL_HOURS (default 72) and the cache is held under EVIDENCE_CACHE_MAX_MB
 * (default 1024) by evicting the oldest files; jobs/retention-sweeper.js prunes nightly and a
 * write that pushes the cache over its budget prunes immediately.
 *
 * Members who opted out with /privacy opt-out message-logging are never captured or re-hosted.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentBuilder, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';
import { isMessageLoggingOptedOut } from './privacy-settings.js';
import {
    extensionOf, isImageAttachment, sanitizeFilename, filenameFromUrl, isSignedUrlExpired, trimUrl,
    uploadLimitBytes, packBatches, resolveCachePath, clampMaxMb,
} from './evidence-helpers.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = process.env.EVIDENCE_CACHE_DIR || path.join(PROJECT_ROOT, 'data', 'evidence-cache');
const CACHE_TTL_MS = (Number(process.env.EVIDENCE_CACHE_TTL_HOURS) || 72) * 60 * 60 * 1000;
const CACHE_MAX_BYTES = (Number(process.env.EVIDENCE_CACHE_MAX_MB) || 1024) * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_DOWNLOADS = 3;
const MAX_QUEUED_DOWNLOADS = 200;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_BULK_FILES = 30;
const SNOWFLAKE = /^\d{15,25}$/;
// Only ever fetch Discord's own CDN: the URLs come from Discord, but they pass through our DB.
const DISCORD_CDN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i;

// ─── Configuration ─────────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ enabled: boolean, channelId?: string|null, maxBytes?: number }>}
 */
export async function getEvidenceConfig(guildId) {
    try {
        return await configCache.get('evidence_config', guildId, async () => {
            const [rows] = await pool.execute(
                'SELECT evidence_capture_enabled, evidence_channel_id, evidence_max_mb FROM logging_config WHERE guild_id = ?',
                [guildId]
            );
            const row = rows[0];
            if (!row || !Number(row.evidence_capture_enabled)) return { enabled: false };
            return {
                enabled: true,
                channelId: row.evidence_channel_id || null,
                maxBytes: clampMaxMb(row.evidence_max_mb) * 1024 * 1024,
            };
        });
    } catch (error) {
        logger.error('[Evidence] Failed to read evidence config', { guildId, error: error.message });
        return { enabled: false };
    }
}

// ─── Downloading ───────────────────────────────────────────────────────────────────────────

/** GET a Discord CDN file, giving up past maxBytes or the timeout. Returns a Buffer or null. */
async function fetchBounded(url, maxBytes) {
    if (!url || !DISCORD_CDN.test(url) || isSignedUrlExpired(url)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok || !res.body) return null;
        const declared = Number(res.headers.get('content-length'));
        if (declared && declared > maxBytes) {
            controller.abort();
            return null;
        }
        const chunks = [];
        let total = 0;
        for await (const chunk of res.body) {
            total += chunk.length;
            if (total > maxBytes) {
                controller.abort();
                return null;
            }
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    } catch (error) {
        if (error.name !== 'AbortError') logger.debug('[Evidence] Download failed', { error: error.message });
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const queue = [];
let activeDownloads = 0;
let droppedDownloads = 0;

function enqueueDownload(job) {
    if (queue.length >= MAX_QUEUED_DOWNLOADS) {
        droppedDownloads++;
        if (droppedDownloads % 50 === 1) {
            logger.warn('[Evidence] Capture queue full; skipping image copies', { dropped: droppedDownloads });
        }
        return;
    }
    queue.push(job);
    pumpQueue();
}

function pumpQueue() {
    while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && queue.length) {
        const job = queue.shift();
        activeDownloads++;
        cacheImage(job)
            .catch(error => logger.warn('[Evidence] Could not cache image', { guildId: job.guildId, messageId: job.messageId, error: error.message }))
            .finally(() => {
                activeDownloads--;
                pumpQueue();
            });
    }
}

async function cacheImage(job) {
    const buffer = (await fetchBounded(job.proxyUrl, job.maxBytes)) || (await fetchBounded(job.url, job.maxBytes));
    if (!buffer) return;
    const ext = extensionOf(job.name || job.url) || '.bin';
    const relative = `${job.guildId}/${job.messageId}-${job.attachmentId}${ext}`;
    const full = resolveCachePath(CACHE_DIR, relative);
    if (!full) return;
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer, { mode: 0o600 });
    noteCacheWrite(buffer.length);
    await pool.execute(
        'UPDATE message_attachments SET cache_path = ? WHERE message_log_id = ? AND attachment_id = ?',
        [relative, job.messageLogId, job.attachmentId]
    );
}

/**
 * Record a new message's attachments, and queue private copies of its images. Called by
 * utils/message-cache.js#saveMessage after the message_logs row exists. Never throws.
 */
export async function captureAttachments(message, messageLogId) {
    try {
        if (!message.guild || !messageLogId || !message.attachments?.size) return;
        const cfg = await getEvidenceConfig(message.guild.id);
        if (!cfg.enabled) return;
        if (await isMessageLoggingOptedOut(message.author?.id)) return;

        const guildId = message.guild.id;
        if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(message.id)) return;

        for (const att of [...message.attachments.values()].slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
            await pool.execute(
                `INSERT IGNORE INTO message_attachments
                    (message_log_id, attachment_id, original_url, filename, file_size, file_type)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    messageLogId,
                    att.id,
                    trimUrl(att.url),
                    sanitizeFilename(att.name),
                    Number.isFinite(att.size) ? att.size : null,
                    att.contentType ? String(att.contentType).slice(0, 50) : null,
                ]
            );
            if (isImageAttachment(att) && SNOWFLAKE.test(att.id) && (!att.size || att.size <= cfg.maxBytes)) {
                enqueueDownload({
                    guildId, messageId: message.id, attachmentId: att.id, messageLogId,
                    url: att.url, proxyUrl: att.proxyURL, name: att.name, maxBytes: cfg.maxBytes,
                });
            }
        }
    } catch (error) {
        logger.error('[Evidence] Failed to record attachments', { messageId: message?.id, error: error.message });
    }
}

// ─── Local cache upkeep ────────────────────────────────────────────────────────────────────

let cacheBytes = null;   // unknown until the first prune scans the directory
let pruning = null;

function noteCacheWrite(bytes) {
    if (cacheBytes !== null) cacheBytes += bytes;
    if (cacheBytes === null || cacheBytes > CACHE_MAX_BYTES) {
        if (!pruning) {
            pruning = pruneEvidenceCache()
                .catch(error => logger.error('[Evidence] Cache prune failed', { error: error.message }))
                .finally(() => { pruning = null; });
        }
    }
}

/**
 * Delete cached copies older than the TTL, then the oldest ones until the cache fits its budget.
 * Run nightly by jobs/retention-sweeper.js and whenever a write overflows the budget.
 */
export async function pruneEvidenceCache() {
    const files = [];
    let guildDirs;
    try {
        guildDirs = await fsp.readdir(CACHE_DIR, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            cacheBytes = 0;
            return { removed: 0, freedBytes: 0, remaining: 0, bytes: 0 };
        }
        throw error;
    }
    for (const dir of guildDirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = path.join(CACHE_DIR, dir.name);
        for (const name of await fsp.readdir(dirPath).catch(() => [])) {
            const full = path.join(dirPath, name);
            const st = await fsp.stat(full).catch(() => null);
            if (st?.isFile()) files.push({ full, size: st.size, mtime: st.mtimeMs });
        }
    }

    const now = Date.now();
    let removed = 0;
    let freedBytes = 0;
    const keep = [];
    for (const f of files) {
        if (now - f.mtime > CACHE_TTL_MS) {
            if (await fsp.unlink(f.full).then(() => true, () => false)) {
                removed++;
                freedBytes += f.size;
            }
        } else {
            keep.push(f);
        }
    }
    keep.sort((a, b) => a.mtime - b.mtime);
    let total = keep.reduce((s, f) => s + f.size, 0);
    while (total > CACHE_MAX_BYTES && keep.length) {
        const f = keep.shift();
        if (await fsp.unlink(f.full).then(() => true, () => false)) {
            removed++;
            freedBytes += f.size;
        }
        total -= f.size;
    }
    cacheBytes = total;

    // Tidy empty guild folders; rmdir refuses non-empty ones, which is what we want.
    for (const dir of guildDirs) {
        if (dir.isDirectory()) await fsp.rmdir(path.join(CACHE_DIR, dir.name)).catch(() => {});
    }

    if (removed) logger.info(`[Evidence] Pruned ${removed} cached image(s), freed ${(freedBytes / 1048576).toFixed(1)} MB`);
    return { removed, freedBytes, remaining: keep.length, bytes: total };
}

async function readCached(relative) {
    const full = resolveCachePath(CACHE_DIR, relative);
    if (!full) return null;
    return fsp.readFile(full).catch(() => null);
}

async function removeCached(relative) {
    const full = resolveCachePath(CACHE_DIR, relative);
    if (full) await fsp.unlink(full).catch(() => {});
}

/**
 * Remove every cached copy of a member's images (privacy opt-out / delete). Re-hosted evidence
 * of messages that were already deleted is not touched — it lives in the server's channel.
 * @returns {Promise<number>} files removed
 */
export async function purgeUserEvidenceCache(userId) {
    const [rows] = await pool.execute(
        `SELECT ma.id, ma.cache_path
           FROM message_attachments ma
           JOIN message_logs ml ON ml.id = ma.message_log_id
          WHERE ml.author_id = ? AND ma.cache_path IS NOT NULL`,
        [userId]
    );
    for (const row of rows) await removeCached(row.cache_path);
    for (let i = 0; i < rows.length; i += 500) {
        const ids = rows.slice(i, i + 500).map(r => r.id);
        await pool.execute(`UPDATE message_attachments SET cache_path = NULL WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    }
    return rows.length;
}

// ─── Re-hosting on delete ──────────────────────────────────────────────────────────────────

async function resolveEvidenceChannel(guild, channelId) {
    if (!channelId) return null;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
        logger.warn('[Evidence] Evidence channel missing or not text-based', { guildId: guild.id, channelId });
        return null;
    }
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) {
        logger.warn('[Evidence] Missing View/Send/Attach Files in the evidence channel', { guildId: guild.id, channelId });
        return null;
    }
    return channel;
}

async function loadLogRow(messageId) {
    const [rows] = await pool.execute('SELECT id, attachment_urls FROM message_logs WHERE message_id = ?', [messageId]);
    return rows[0] || null;
}

function parseUrlList(raw) {
    if (!raw) return [];
    try {
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list.filter(u => typeof u === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * Everything known about a deleted message's attachments, best source first: our
 * message_attachments rows (with the cached copy), then discord.js's in-memory message, then
 * the bare URL list in message_logs.
 */
async function collectCandidates({ messageId, logRow, liveAttachments }) {
    const live = liveAttachments ? [...liveAttachments.values()] : [];
    const liveById = new Map(live.map(a => [a.id, a]));
    const row = logRow?.id ? logRow : await loadLogRow(messageId);

    let candidates = [];
    if (row?.id) {
        const [atts] = await pool.execute(
            `SELECT id, attachment_id, original_url, stored_url, filename, file_size, file_type, cache_path,
                    evidence_channel_id, evidence_message_id
               FROM message_attachments WHERE message_log_id = ? ORDER BY id`,
            [row.id]
        );
        candidates = atts.map(a => {
            const l = a.attachment_id ? liveById.get(a.attachment_id) : null;
            return {
                rowId: a.id, messageLogId: row.id, attachmentId: a.attachment_id,
                filename: a.filename || filenameFromUrl(a.original_url), originalUrl: l?.url || a.original_url,
                proxyUrl: l?.proxyURL || null, size: a.file_size, contentType: a.file_type, cachePath: a.cache_path,
                storedUrl: a.stored_url, evidenceChannelId: a.evidence_channel_id, evidenceMessageId: a.evidence_message_id,
            };
        });
    }
    if (!candidates.length && live.length) {
        candidates = live.map(a => ({
            rowId: null, messageLogId: row?.id || null, attachmentId: a.id, filename: sanitizeFilename(a.name),
            originalUrl: a.url, proxyUrl: a.proxyURL, size: a.size, contentType: a.contentType || null,
        }));
    }
    if (!candidates.length && row?.attachment_urls) {
        candidates = parseUrlList(row.attachment_urls).map(url => ({
            rowId: null, messageLogId: row.id, attachmentId: null, filename: filenameFromUrl(url), originalUrl: url,
        }));
    }
    return candidates.slice(0, MAX_ATTACHMENTS_PER_MESSAGE).map(c => ({ ...c, messageId }));
}

const jumpLink = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

/**
 * Re-upload candidates to the target channel in as few messages as the size limit allows.
 * Mutates nothing it is given; returns per-file results.
 */
async function rehost({ guild, target, header, candidates, maxBytes }) {
    const items = [];
    const uploads = [];

    for (const c of candidates) {
        const item = { messageId: c.messageId, filename: c.filename, originalUrl: c.originalUrl, size: c.size ?? null, status: 'pending' };
        items.push(item);

        if (c.storedUrl && c.evidenceMessageId) {           // a second delete event for the same message
            Object.assign(item, { status: 'rehosted', storedUrl: c.storedUrl, jumpUrl: jumpLink(guild.id, c.evidenceChannelId, c.evidenceMessageId) });
            continue;
        }
        if (!isImageAttachment({ contentType: c.contentType, name: c.filename, url: c.originalUrl })) { item.status = 'not_image'; continue; }
        if (c.size && c.size > maxBytes) { item.status = 'too_large'; continue; }

        const buffer = (await readCached(c.cachePath))
            || (await fetchBounded(c.proxyUrl, maxBytes))
            || (await fetchBounded(c.originalUrl, maxBytes));
        if (!buffer) { item.status = 'unavailable'; continue; }

        const prefix = c.namePrefix ? `${c.namePrefix}-` : '';
        uploads.push({ item, candidate: c, buffer, size: buffer.length, name: sanitizeFilename(`${prefix}${uploads.length + 1}-${c.filename}`) });
    }

    if (!uploads.length) return { items, jumpUrl: null };
    if (!target) {
        for (const u of uploads) u.item.status = 'no_channel';
        return { items, jumpUrl: null };
    }

    const { batches, tooLarge } = packBatches(uploads, uploadLimitBytes(guild.premiumTier), 10);
    for (const u of tooLarge) u.item.status = 'too_large';

    let firstJump = null;
    for (const [index, batch] of batches.entries()) {
        try {
            const sent = await target.send({
                content: index === 0 ? header : `${header} *(continued)*`,
                files: batch.map(u => new AttachmentBuilder(u.buffer, { name: u.name })),
                allowedMentions: { parse: [] },
            });
            firstJump = firstJump || sent.url;
            const sentAttachments = [...sent.attachments.values()];
            for (const [i, u] of batch.entries()) {
                const a = sentAttachments[i];
                Object.assign(u.item, { status: a ? 'rehosted' : 'failed', storedUrl: a?.url || null, jumpUrl: sent.url });
                if (a) await persistRehost(u.candidate, a, sent).catch(error =>
                    logger.error('[Evidence] Failed to store re-hosted URL', { messageId: u.candidate.messageId, error: error.message }));
                if (a && u.candidate.cachePath) await removeCached(u.candidate.cachePath);
            }
        } catch (error) {
            logger.warn('[Evidence] Re-upload failed', { guildId: guild.id, channelId: target.id, error: error.message });
            for (const u of batch) u.item.status = 'failed';
        }
    }
    return { items, jumpUrl: firstJump };
}

async function persistRehost(candidate, attachment, sent) {
    const storedUrl = trimUrl(attachment.url);
    if (candidate.rowId) {
        await pool.execute(
            `UPDATE message_attachments
                SET stored_url = ?, evidence_channel_id = ?, evidence_message_id = ?, rehosted_at = NOW(), cache_path = NULL
              WHERE id = ?`,
            [storedUrl, sent.channelId, sent.id, candidate.rowId]
        );
    } else if (candidate.messageLogId) {
        await pool.execute(
            `INSERT INTO message_attachments
                (message_log_id, attachment_id, original_url, stored_url, filename, file_size, file_type,
                 evidence_channel_id, evidence_message_id, rehosted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE stored_url = VALUES(stored_url), evidence_channel_id = VALUES(evidence_channel_id),
                evidence_message_id = VALUES(evidence_message_id), rehosted_at = NOW()`,
            [
                candidate.messageLogId, candidate.attachmentId || null, trimUrl(candidate.originalUrl), storedUrl,
                sanitizeFilename(candidate.filename), attachment.size ?? null,
                candidate.contentType ? String(candidate.contentType).slice(0, 50) : null, sent.channelId, sent.id,
            ]
        );
    }
}

/**
 * Preserve the attachments of one deleted message.
 * @param {object} p
 * @param {import('discord.js').Guild} p.guild
 * @param {string} p.sourceChannelId   where the message was
 * @param {string} p.messageId
 * @param {string|null} p.authorId
 * @param {string|null} p.authorTag
 * @param {import('discord.js').Collection|null} p.liveAttachments  discord.js copy, when it had one
 * @param {object|null} p.logRow       message_logs row if the caller already loaded it
 * @param {string|null} p.fallbackChannelId  the message-delete log channel
 * @returns {Promise<null | { items: object[], jumpUrl: string|null, skipped?: string }>} null when the feature is off
 */
export async function preserveDeletedAttachments({ guild, sourceChannelId, messageId, authorId, authorTag, liveAttachments, logRow, fallbackChannelId }) {
    const cfg = await getEvidenceConfig(guild.id);
    if (!cfg.enabled) return null;
    if (authorId && await isMessageLoggingOptedOut(authorId)) return { items: [], jumpUrl: null, skipped: 'opted_out' };

    const candidates = await collectCandidates({ messageId, logRow, liveAttachments });
    if (!candidates.length) return null;

    const target = await resolveEvidenceChannel(guild, cfg.channelId || fallbackChannelId);
    const who = authorTag ? `**${escapeMarkdown(String(authorTag))}** ` : '';
    const id = authorId ? `(\`${authorId}\`) ` : '';
    const header = `🗂️ **Deleted-message evidence** — ${who}${id}in <#${sourceChannelId}> · message \`${messageId}\``;
    return rehost({ guild, target, header, candidates, maxBytes: cfg.maxBytes });
}

/**
 * Preserve the attachments of a bulk delete (purge). At most MAX_BULK_FILES files, in as few
 * evidence messages as the upload limit allows; each file name starts with its message id.
 * @param {object} p
 * @param {Array<{ messageId: string, authorId: string|null, liveAttachments: any, logRow: object|null }>} p.entries
 * @returns {Promise<null | { messages: number, rehosted: number, failed: number, skippedOptOut: number, jumpUrl: string|null, truncated: boolean }>}
 */
export async function preserveBulkDeletedAttachments({ guild, sourceChannelId, entries, fallbackChannelId }) {
    const cfg = await getEvidenceConfig(guild.id);
    if (!cfg.enabled || !entries?.length) return null;

    const candidates = [];
    let messages = 0;
    let skippedOptOut = 0;
    let truncated = false;
    for (const e of entries) {
        if (e.authorId && await isMessageLoggingOptedOut(e.authorId)) { skippedOptOut++; continue; }
        const list = await collectCandidates({ messageId: e.messageId, logRow: e.logRow, liveAttachments: e.liveAttachments });
        if (!list.length) continue;
        messages++;
        for (const c of list) {
            if (candidates.length >= MAX_BULK_FILES) { truncated = true; break; }
            candidates.push({ ...c, namePrefix: e.messageId });
        }
        if (truncated) break;
    }
    if (!candidates.length) return { messages: 0, rehosted: 0, failed: 0, skippedOptOut, jumpUrl: null, truncated };

    const target = await resolveEvidenceChannel(guild, cfg.channelId || fallbackChannelId);
    const header = `🗂️ **Bulk-delete evidence** — attachments from ${messages} deleted message(s) in <#${sourceChannelId}>. File names start with the message id.`;
    const { items, jumpUrl } = await rehost({ guild, target, header, candidates, maxBytes: cfg.maxBytes });
    return {
        messages,
        rehosted: items.filter(i => i.status === 'rehosted').length,
        failed: items.filter(i => i.status !== 'rehosted').length,
        skippedOptOut,
        jumpUrl,
        truncated,
    };
}

/**
 * The "Attachments" field for a delete log embed.
 * @param {null|{ items: object[], jumpUrl: string|null, skipped?: string }} evidence
 * @param {Array<{ name: string, url: string }>} fallback  attachments known without the evidence feature
 */
export function describeAttachments(evidence, fallback = []) {
    const lines = [];
    const reason = {
        not_image: 'not an image — not re-hosted',
        too_large: 'over the size limit — not re-hosted',
        unavailable: 'could not be retrieved',
        no_channel: 'no usable evidence channel',
        failed: 're-upload failed',
    };
    if (evidence?.items?.length) {
        for (const item of evidence.items) {
            const name = escapeMarkdown(item.filename || 'attachment');
            if (item.status === 'rehosted' && item.jumpUrl) lines.push(`• [${name}](${item.jumpUrl}) — preserved`);
            else lines.push(`• ${name} — ${reason[item.status] || item.status}`);
        }
    } else {
        for (const a of fallback) {
            const name = escapeMarkdown(a.name || 'attachment');
            lines.push(a.url ? `• [${name}](${a.url}) *(original link — stops working once deleted)*` : `• ${name}`);
        }
    }
    if (!lines.length) return null;
    let text = '';
    for (const line of lines) {
        if (text.length + line.length + 1 > 1000) { text += '…'; break; }
        text += `${line}\n`;
    }
    return text.trim();
}

export default {
    getEvidenceConfig, captureAttachments, preserveDeletedAttachments, preserveBulkDeletedAttachments,
    pruneEvidenceCache, purgeUserEvidenceCache, describeAttachments, CACHE_DIR,
};
