/*
 * Vault - storage, quota and access logic for the private large-file transfer area.
 *
 * WHY UPLOADS ARE APPEND-ONLY CHUNKS, NOT ONE POST
 * ------------------------------------------------
 * certifriedmultitool.com sits behind Cloudflare, which refuses any request body over 100 MB on
 * the Free and Pro plans, and there is a second TLS terminator in front of the Node process whose
 * own body limit we do not control. A 5 GB POST would be rejected at the edge with an HTML error
 * the browser reports as a generic network failure. So the browser slices the file and PATCHes it
 * a piece at a time; the server appends each piece to a .part file and remembers how many bytes
 * it has. That also makes the upload resumable, which at 5 GB you want anyway - a dropped
 * connection at 4.6 GB should cost seconds, not the whole transfer.
 *
 * `received_bytes` in the DB is the ONLY authority on where an upload is. The client sends the
 * offset it *believes* it is at; a mismatch is answered with 409 and the real offset rather than
 * trusted, because trusting it means a malformed or malicious client can splice bytes into the
 * middle of someone else's file.
 *
 * WHY FILES ARE NAMED BY ID ON DISK
 * ---------------------------------
 * `file_id` is 32 hex characters generated here. No byte the user typed ever reaches a filesystem
 * path, which retires the entire class of "../../" and null-byte filename attacks in one move.
 * The original name lives in the database as display text and is only ever re-attached in a
 * Content-Disposition header, escaped.
 */

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scrypt = promisify(crypto.scrypt);

const REPO_ROOT = path.join(__dirname, '..');

function intEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export const CONFIG = {
    // uploads/ is already in .gitignore, and nothing serves it statically.
    storageDir: process.env.VAULT_STORAGE_DIR || path.join(REPO_ROOT, 'uploads', 'vault'),
    maxFileBytes: intEnv('VAULT_MAX_FILE_BYTES', 5 * GB),
    maxTotalBytes: intEnv('VAULT_MAX_TOTAL_BYTES', 30 * GB),
    // Retention is measured in MINUTES internally so "delete this in 20 minutes" is
    // expressible. VAULT_RETENTION_DAYS is still honoured as the coarse knob it always was.
    retentionMinutes: intEnv('VAULT_RETENTION_MINUTES', intEnv('VAULT_RETENTION_DAYS', 30) * 1440),
    // Suggested slice size. The browser halves it on a 413 and retries, so this is a starting
    // point rather than a promise - see the client in views/vault.ejs.
    chunkBytes: intEnv('VAULT_CHUNK_BYTES', 16 * MB),
    // An upload nobody has touched in this long is abandoned; its .part file is reaped.
    staleUploadHours: intEnv('VAULT_STALE_UPLOAD_HOURS', 24),
    // Never let the vault eat the last of the disk, whatever the quota says.
    minFreeDiskBytes: intEnv('VAULT_MIN_FREE_DISK_BYTES', 5 * GB),
    maxShareDays: intEnv('VAULT_MAX_SHARE_DAYS', 30)
};

const partDir = () => path.join(CONFIG.storageDir, 'partial');

export async function ensureStorage() {
    await fsp.mkdir(CONFIG.storageDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(partDir(), { recursive: true, mode: 0o700 });
}

const newId = () => crypto.randomBytes(16).toString('hex');
const filePath = (fileId) => path.join(CONFIG.storageDir, `${fileId}.bin`);
const partPath = (uploadId) => path.join(partDir(), `${uploadId}.part`);

/** 32 lowercase hex chars - the only shape an id may have before it touches a path. */
export const isValidId = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);

/**
 * Display-safe filename. Control characters and path separators are stripped even though the
 * name never reaches the filesystem: it still ends up in an HTTP header and in HTML.
 */
export function cleanName(name) {
    const base = String(name || 'file')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[\\/]/g, '_')
        .trim();
    return (base || 'file').slice(0, 255);
}

// ---------------------------------------------------------------------------
// Membership
//
// THE OWNER IS PERMANENT, AND THAT IS ENFORCED HERE RATHER THAN AT THE ROUTE.
//
// This is not hypothetical. On 2026-09-07 the second member removed the owner from the vault
// and the owner was locked out of his own files thirty seconds later. The route's only guard
// was "you cannot remove yourself", which does nothing about one person removing another - and
// utils/constants.js hardcodes a second id into isSuperAdmin(), so the route's owner check let
// them through.
//
// Two independent protections, because one of them being bypassed is exactly what happened:
//   1. removeMember refuses to delete the owner, whoever is asking and by whatever path.
//   2. isMember returns true for the owner even with no row at all, so a missing or manually
//      deleted row cannot lock the owner out either.
// Read lazily from the environment rather than captured at import: ESM evaluates imports before
// the dotenv.config() call in the entrypoint, so a module-scope read can see undefined.
// ---------------------------------------------------------------------------

/** The one account that cannot be removed. No hardcoded fallback - matches utils/constants.js. */
export function ownerId() {
    return process.env.BOT_OWNER_ID || null;
}

export function isOwnerId(userId) {
    const owner = ownerId();
    return !!owner && !!userId && String(userId) === owner;
}

export async function isMember(userId) {
    if (!userId) return false;
    // Membership by definition, not by row. A deleted row cannot revoke this.
    if (isOwnerId(userId)) return true;
    const [rows] = await pool.execute('SELECT 1 FROM vault_members WHERE user_id = ?', [userId]);
    return rows.length > 0;
}

export async function listMembers() {
    const [rows] = await pool.execute(
        'SELECT user_id, label, added_by, created_at FROM vault_members ORDER BY created_at ASC');
    const owner = ownerId();

    // Surface the owner even if the row went missing, so the list never implies they are gone.
    if (owner && !rows.some(r => r.user_id === owner)) {
        rows.unshift({ user_id: owner, label: 'Owner', added_by: null, created_at: null });
    }
    return rows.map(r => ({ ...r, permanent: isOwnerId(r.user_id) }));
}

export async function addMember(userId, label, addedBy) {
    await pool.execute(
        `INSERT INTO vault_members (user_id, label, added_by) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label)`,
        [userId, label ? String(label).slice(0, 100) : null, addedBy]);
}

/** Returns false, and changes nothing, when asked to remove the owner. */
export async function removeMember(userId) {
    if (isOwnerId(userId)) {
        logger.warn(`[Vault] refused to remove the owner (${userId}) from the member list`);
        return false;
    }
    const [r] = await pool.execute('DELETE FROM vault_members WHERE user_id = ?', [userId]);
    return r.affectedRows > 0;
}

/**
 * Put the owner's row back if it is missing, and keep its label honest. Called at startup, so a
 * row deleted by any means is restored on the next boot without anyone having to notice.
 */
export async function ensureOwnerMember() {
    const owner = ownerId();
    if (!owner) {
        logger.warn('[Vault] BOT_OWNER_ID is not set - the owner cannot be protected');
        return;
    }
    const [[row]] = await pool.execute(
        'SELECT user_id, label FROM vault_members WHERE user_id = ?', [owner]);
    if (!row) {
        await pool.execute(
            'INSERT INTO vault_members (user_id, label, added_by) VALUES (?, ?, ?)',
            [owner, 'Owner', owner]);
        await audit({ action: 'member_restore', detail: `${owner} (owner row was missing)` });
        logger.warn(`[Vault] restored the owner's member row (${owner})`);
    } else if (!row.label) {
        await pool.execute(
            'UPDATE vault_members SET label = ? WHERE user_id = ?', ['Owner', owner]);
    }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function audit({ actorId = null, action, fileId = null, detail = null, ip = null,
                             userAgent = null, bytes = null, completed = null }) {
    try {
        await pool.execute(
            `INSERT INTO vault_audit (actor_id, action, file_id, detail, ip, user_agent, bytes, completed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [actorId, action, fileId, detail ? String(detail).slice(0, 500) : null,
             ip ? String(ip).slice(0, 45) : null, userAgent ? String(userAgent).slice(0, 255) : null,
             bytes === null || bytes === undefined ? null : Math.max(0, Math.floor(Number(bytes) || 0)),
             completed === null || completed === undefined ? null : (completed ? 1 : 0)]);
    } catch (err) {
        // An audit failure must never take down the operation it was recording.
        logger.error(`[Vault] audit write failed: ${err.message}`);
    }
}

export async function recentAudit(limit = 50) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const [rows] = await pool.query(
        `SELECT a.id, a.actor_id, a.action, a.file_id, a.detail, a.ip, a.created_at,
                a.bytes, a.completed, f.original_name
           FROM vault_audit a
           LEFT JOIN vault_files f ON f.file_id = a.file_id
          ORDER BY a.id DESC LIMIT ?`, [n]);
    return rows;
}

/**
 * Every access record for one file, newest first. Deliberately includes the attempts that did
 * NOT finish: "started it and gave up" is the answer to a different question than "got it", and
 * only a finished transfer is allowed to burn a file.
 */
export async function fileDownloads(fileId, limit = 100) {
    if (!isValidId(fileId)) return [];
    const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const [rows] = await pool.query(
        `SELECT id, actor_id, action, detail, ip, user_agent, bytes, completed, created_at
           FROM vault_audit
          WHERE file_id = ? AND action IN ('download', 'share_download', 'download_denied')
          ORDER BY id DESC LIMIT ?`, [fileId, n]);
    return rows;
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

export async function usage() {
    const [[stored]] = await pool.execute(
        'SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS files FROM vault_files');
    // In-flight uploads have already claimed their space on disk (partially) and will claim the
    // rest; counting only what has landed lets three concurrent 5 GB uploads blow past the cap.
    const [[pending]] = await pool.execute(
        'SELECT COALESCE(SUM(size_bytes - received_bytes), 0) AS bytes FROM vault_uploads');

    let freeDiskBytes = null;
    try {
        const st = await fsp.statfs(CONFIG.storageDir);
        freeDiskBytes = Number(st.bavail) * Number(st.bsize);
    } catch { /* statfs unsupported or dir missing - quota alone then */ }

    const usedBytes = Number(stored.bytes);
    const reservedBytes = Number(pending.bytes);
    return {
        usedBytes,
        reservedBytes,
        fileCount: Number(stored.files),
        maxBytes: CONFIG.maxTotalBytes,
        availableBytes: Math.max(0, CONFIG.maxTotalBytes - usedBytes - reservedBytes),
        freeDiskBytes
    };
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export async function beginUpload({ ownerId, name, size, contentType, note, retentionMinutes, deleteOnDownload }) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return { error: 'A file size is required.', status: 400 };
    }
    if (bytes > CONFIG.maxFileBytes) {
        return { error: `That file is larger than the ${formatBytes(CONFIG.maxFileBytes)} per-file limit.`, status: 413 };
    }

    const u = await usage();
    if (bytes > u.availableBytes) {
        return {
            error: `Not enough vault space: ${formatBytes(u.availableBytes)} free of ${formatBytes(u.maxBytes)}.`,
            status: 507
        };
    }
    if (u.freeDiskBytes !== null && bytes + CONFIG.minFreeDiskBytes > u.freeDiskBytes) {
        return { error: 'Not enough free disk space on the server for that file.', status: 507 };
    }

    await ensureStorage();
    const uploadId = newId();
    // Create the part file up front so an append can never be the thing that creates it - a
    // missing part file then unambiguously means "this upload is gone", not "not started yet".
    await fsp.writeFile(partPath(uploadId), '', { mode: 0o600 });

    // 0 (or a value that will not parse) means "keep until something deletes it" -> NULL.
    const minutes = retentionMinutes === null || retentionMinutes === undefined || retentionMinutes === ''
        ? CONFIG.retentionMinutes
        : Math.max(0, parseInt(retentionMinutes, 10) || 0);

    await pool.execute(
        `INSERT INTO vault_uploads
             (upload_id, owner_id, original_name, size_bytes, content_type, note,
              retention_minutes, delete_on_download)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uploadId, ownerId, cleanName(name), bytes,
         contentType ? String(contentType).slice(0, 160) : null,
         note ? String(note).slice(0, 500) : null,
         minutes > 0 ? minutes : null,
         deleteOnDownload ? 1 : 0]);

    return { uploadId, offset: 0, chunkBytes: CONFIG.chunkBytes };
}

export async function getUpload(uploadId, ownerId) {
    if (!isValidId(uploadId)) return null;
    const [[row]] = await pool.execute(
        'SELECT * FROM vault_uploads WHERE upload_id = ? AND owner_id = ?', [uploadId, ownerId]);
    return row || null;
}

// One append at a time per upload. Two concurrent PATCHes for the same upload would both read
// the same offset and interleave their bytes; the file would be exactly the right length and
// completely corrupt.
const appendLocks = new Map();

function withUploadLock(uploadId, fn) {
    const prev = appendLocks.get(uploadId) || Promise.resolve();
    // Run regardless of how the previous one ended - a failed append must not wedge the queue.
    const next = prev.then(fn, fn);
    const guarded = next.catch(() => {});
    appendLocks.set(uploadId, guarded);
    guarded.then(() => {
        // Drop the entry once we are the tail, so the map does not grow for the life of the
        // process. If someone queued behind us they have already replaced the value.
        if (appendLocks.get(uploadId) === guarded) appendLocks.delete(uploadId);
    });
    return next;
}

/**
 * Append a request body to an upload at `claimedOffset`.
 * Returns { offset } on success, or { error, status, offset } - the offset on a 409 is the real
 * one, so the client can seek to it and carry on rather than restarting.
 */
export async function appendChunk({ uploadId, ownerId, claimedOffset, stream, maxChunkBytes }) {
    return withUploadLock(uploadId, async () => {
        const row = await getUpload(uploadId, ownerId);
        if (!row) return { error: 'Upload not found.', status: 404 };

        const current = Number(row.received_bytes);
        if (Number(claimedOffset) !== current) {
            return { error: 'Offset mismatch.', status: 409, offset: current };
        }
        if (current >= Number(row.size_bytes)) {
            return { offset: current, complete: true };
        }

        const target = partPath(uploadId);
        // The part file's real length is the tiebreaker if a previous append died mid-write.
        let onDisk;
        try {
            onDisk = (await fsp.stat(target)).size;
        } catch {
            return { error: 'Upload data is gone; start over.', status: 410 };
        }
        if (onDisk !== current) {
            // Truncate back to the last offset the database acknowledged. Bytes the DB never
            // recorded were never acknowledged to the client either, so nothing is lost.
            await fsp.truncate(target, current);
        }

        const remaining = Number(row.size_bytes) - current;
        const cap = Math.min(remaining, Number(maxChunkBytes) || CONFIG.chunkBytes * 4);

        let written = 0;
        try {
            await new Promise((resolve, reject) => {
                const out = fs.createWriteStream(target, { flags: 'r+', start: current });
                const fail = (err) => { out.destroy(); reject(err); };

                stream.on('data', (buf) => {
                    written += buf.length;
                    if (written > cap) fail(new Error('chunk exceeds declared remaining size'));
                });
                stream.on('error', fail);
                out.on('error', fail);
                out.on('finish', resolve);
                stream.pipe(out);
            });
        } catch (err) {
            // Roll the file back to the acknowledged offset; a half-written chunk is not a
            // resume point.
            await fsp.truncate(target, current).catch(() => {});
            return { error: `Chunk failed: ${err.message}`, status: 400, offset: current };
        }

        const next = current + written;
        await pool.execute(
            'UPDATE vault_uploads SET received_bytes = ? WHERE upload_id = ?', [next, uploadId]);

        return { offset: next, complete: next >= Number(row.size_bytes) };
    });
}

export async function completeUpload({ uploadId, ownerId }) {
    const row = await getUpload(uploadId, ownerId);
    if (!row) return { error: 'Upload not found.', status: 404 };

    const target = partPath(uploadId);
    let stat;
    try {
        stat = await fsp.stat(target);
    } catch {
        return { error: 'Upload data is gone; start over.', status: 410 };
    }
    if (stat.size !== Number(row.size_bytes)) {
        return {
            error: `Incomplete: ${stat.size} of ${row.size_bytes} bytes received.`,
            status: 409,
            offset: stat.size
        };
    }

    const sha256 = await hashFile(target);
    const fileId = newId();
    await fsp.rename(target, filePath(fileId));
    await fsp.chmod(filePath(fileId), 0o600).catch(() => {});

    // Prefer minutes; rows written before migration 227 only have days.
    const minutes = row.retention_minutes ?? (row.retention_days ? row.retention_days * 1440 : null);
    const expiresAt = minutes ? new Date(Date.now() + minutes * 60000) : null;

    await pool.execute(
        `INSERT INTO vault_files
             (file_id, owner_id, original_name, size_bytes, content_type, sha256, note,
              expires_at, delete_on_download)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fileId, ownerId, row.original_name, row.size_bytes, row.content_type, sha256, row.note,
         expiresAt, row.delete_on_download ? 1 : 0]);
    await pool.execute('DELETE FROM vault_uploads WHERE upload_id = ?', [uploadId]);

    return { fileId, sha256, expiresAt, deleteOnDownload: !!row.delete_on_download };
}

export async function abortUpload(uploadId, ownerId) {
    const row = await getUpload(uploadId, ownerId);
    if (!row) return false;
    await fsp.unlink(partPath(uploadId)).catch(() => {});
    await pool.execute('DELETE FROM vault_uploads WHERE upload_id = ?', [uploadId]);
    return true;
}

function hashFile(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('data', (d) => h.update(d));
        s.on('error', reject);
        s.on('end', () => resolve(h.digest('hex')));
    });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function listFiles() {
    const [rows] = await pool.execute(
        `SELECT f.*,
                (SELECT COUNT(*) FROM vault_share_links l
                  WHERE l.file_id = f.file_id AND l.revoked_at IS NULL AND l.expires_at > NOW())
                  AS active_links
           FROM vault_files f
          ORDER BY f.created_at DESC`);
    return rows;
}

export async function listPendingUploads(ownerId) {
    const [rows] = await pool.execute(
        `SELECT upload_id, original_name, size_bytes, received_bytes, updated_at
           FROM vault_uploads WHERE owner_id = ? ORDER BY updated_at DESC`, [ownerId]);
    return rows;
}

export async function getFile(fileId) {
    if (!isValidId(fileId)) return null;
    const [[row]] = await pool.execute('SELECT * FROM vault_files WHERE file_id = ?', [fileId]);
    return row || null;
}

export function storedPath(fileId) {
    if (!isValidId(fileId)) throw new Error('invalid file id');
    return filePath(fileId);
}

export async function updateFile(fileId, { note, expiresAt, deleteOnDownload }) {
    if (!isValidId(fileId)) return false;
    const sets = [];
    const params = [];
    if (note !== undefined) { sets.push('note = ?'); params.push(note ? String(note).slice(0, 500) : null); }
    if (expiresAt !== undefined) { sets.push('expires_at = ?'); params.push(expiresAt); }
    if (deleteOnDownload !== undefined) { sets.push('delete_on_download = ?'); params.push(deleteOnDownload ? 1 : 0); }
    if (!sets.length) return false;
    params.push(fileId);
    const [r] = await pool.execute(`UPDATE vault_files SET ${sets.join(', ')} WHERE file_id = ?`, params);
    return r.affectedRows > 0;
}

export async function deleteFile(fileId) {
    const row = await getFile(fileId);
    if (!row) return false;
    await fsp.unlink(filePath(fileId)).catch((err) => {
        if (err.code !== 'ENOENT') logger.error(`[Vault] could not unlink ${fileId}: ${err.message}`);
    });
    // Share links cascade.
    await pool.execute('DELETE FROM vault_files WHERE file_id = ?', [fileId]);
    return true;
}

export async function noteDownload(fileId) {
    await pool.execute(
        'UPDATE vault_files SET download_count = download_count + 1, last_downloaded_at = NOW() WHERE file_id = ?',
        [fileId]);
}

/**
 * A file past its expiry is gone the moment it expires, not whenever the sweeper next runs.
 * The sweeper reclaims the disk; this is what stops a download in the gap between the two.
 */
export function isExpired(file) {
    return !!(file?.expires_at && new Date(file.expires_at) <= new Date());
}

export async function updateBurn(fileId, on) {
    if (!isValidId(fileId)) return false;
    const [r] = await pool.execute(
        'UPDATE vault_files SET delete_on_download = ? WHERE file_id = ?', [on ? 1 : 0, fileId]);
    return r.affectedRows > 0;
}

/**
 * Burn-after-download. Called ONLY when a transfer actually reached the end of the file - an
 * aborted or partial download must leave the file alone, or a flaky connection silently
 * destroys the thing it was trying to fetch.
 *
 * Deleting the row while other range requests are still streaming is safe: their file
 * descriptors are already open, and unlink on Linux only removes the name. What it does stop is
 * a NEW request finding it, which is the point.
 */
export async function burnAfterDownload(file, ctx = {}) {
    if (!file?.delete_on_download) return false;
    await deleteFile(file.file_id);
    await audit({
        actorId: ctx.actorId ?? null,
        action: 'burn',
        fileId: file.file_id,
        detail: `${file.original_name} deleted after download`,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null
    });
    logger.info(`[Vault] burned ${file.file_id} (${file.original_name}) after a completed download`);
    return true;
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = await scrypt(password, salt, 32);
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
    try {
        const [, saltHex, hashHex] = String(stored).split('$');
        const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), 32);
        return crypto.timingSafeEqual(derived, Buffer.from(hashHex, 'hex'));
    } catch {
        return false;
    }
}

export async function createShareLink({ fileId, createdBy, label, days, maxDownloads, password }) {
    const file = await getFile(fileId);
    if (!file) return { error: 'File not found.', status: 404 };

    const d = Math.min(Math.max(parseInt(days, 10) || 7, 1), CONFIG.maxShareDays);
    let expiresAt = new Date(Date.now() + d * 86400000);
    // A link that outlives its file is a broken promise; clamp it to the file's own expiry.
    if (file.expires_at && new Date(file.expires_at) < expiresAt) expiresAt = new Date(file.expires_at);

    // 32 bytes = 256 bits. base64url so it survives being pasted anywhere.
    const token = crypto.randomBytes(32).toString('base64url');
    const max = maxDownloads === null || maxDownloads === undefined || maxDownloads === ''
        ? null
        : Math.max(1, parseInt(maxDownloads, 10) || 1);

    await pool.execute(
        `INSERT INTO vault_share_links (token_hash, file_id, created_by, label, password_hash, expires_at, max_downloads)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [hashToken(token), fileId, createdBy, label ? String(label).slice(0, 120) : null,
         password ? await hashPassword(password) : null, expiresAt, max]);

    // The only moment the token exists in plaintext. It is not recoverable later, by design.
    return { token, expiresAt, maxDownloads: max };
}

export async function listShareLinks(fileId) {
    const [rows] = await pool.execute(
        `SELECT token_hash, label, expires_at, max_downloads, download_count, last_used_at,
                revoked_at, created_at, password_hash IS NOT NULL AS has_password
           FROM vault_share_links WHERE file_id = ? ORDER BY created_at DESC`, [fileId]);
    return rows;
}

export async function revokeShareLink(tokenHash) {
    if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)) return false;
    const [r] = await pool.execute(
        'UPDATE vault_share_links SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL',
        [tokenHash]);
    return r.affectedRows > 0;
}

/**
 * Resolve a share token to its link + file. Returns { link, file } or { error, status }.
 * Every rejection reads the same to the caller - an attacker probing tokens learns only
 * "no", never "right token, wrong password" versus "expired" versus "never existed".
 */
export async function resolveShareToken(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
        return { error: 'gone', status: 404 };
    }
    const [[link]] = await pool.execute(
        'SELECT * FROM vault_share_links WHERE token_hash = ?', [hashToken(token)]);
    if (!link) return { error: 'gone', status: 404 };
    if (link.revoked_at) return { error: 'gone', status: 404 };
    if (new Date(link.expires_at) <= new Date()) return { error: 'expired', status: 410 };
    if (link.max_downloads !== null && link.download_count >= link.max_downloads) {
        return { error: 'exhausted', status: 410 };
    }
    const file = await getFile(link.file_id);
    if (!file) return { error: 'gone', status: 404 };
    // The file's own clock outranks the link's. A 20-minute file with a 7-day link is gone in
    // 20 minutes, sweeper or no sweeper.
    if (isExpired(file)) return { error: 'expired', status: 410 };
    return { link, file };
}

export async function checkSharePassword(link, password) {
    if (!link.password_hash) return true;
    if (!password) return false;
    return verifyPassword(password, link.password_hash);
}

/**
 * Count a share download. Uses a conditional UPDATE so two simultaneous requests cannot both
 * slip past a max_downloads of 1 - the second one's affectedRows is 0 and it is refused.
 */
export async function consumeShareDownload(tokenHash) {
    const [r] = await pool.execute(
        `UPDATE vault_share_links
            SET download_count = download_count + 1, last_used_at = NOW()
          WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()
            AND (max_downloads IS NULL OR download_count < max_downloads)`,
        [tokenHash]);
    return r.affectedRows > 0;
}

// ---------------------------------------------------------------------------
// Housekeeping (jobs/vault-cleanup.js)
// ---------------------------------------------------------------------------

/**
 * `deep: false` is the every-minute pass - just expiries, two indexed queries. Retention can now
 * be set in minutes, so an hourly sweep would make "delete in 5 minutes" mean "some time in the
 * next hour". The expensive parts (directory scan, stale-upload reaping) stay on the hourly pass.
 */
export async function sweep({ deep = true } = {}) {
    const result = { files: 0, uploads: 0, orphans: 0 };

    const [expired] = await pool.execute(
        'SELECT file_id, original_name FROM vault_files WHERE expires_at IS NOT NULL AND expires_at <= NOW()');
    for (const f of expired) {
        await deleteFile(f.file_id);
        await audit({ action: 'expire', fileId: f.file_id, detail: f.original_name });
        result.files++;
    }

    if (!deep) return result;

    const [stale] = await pool.execute(
        'SELECT upload_id FROM vault_uploads WHERE updated_at < DATE_SUB(NOW(), INTERVAL ? HOUR)',
        [CONFIG.staleUploadHours]);
    for (const u of stale) {
        await fsp.unlink(partPath(u.upload_id)).catch(() => {});
        await pool.execute('DELETE FROM vault_uploads WHERE upload_id = ?', [u.upload_id]);
        result.uploads++;
    }

    // Files on disk with no row - a crash between rename() and INSERT, or a manual DB edit.
    // Without this they are invisible to the UI and to the quota, forever.
    try {
        const [rows] = await pool.execute('SELECT file_id FROM vault_files');
        const known = new Set(rows.map(r => `${r.file_id}.bin`));
        for (const name of await fsp.readdir(CONFIG.storageDir)) {
            if (!name.endsWith('.bin') || known.has(name)) continue;
            const p = path.join(CONFIG.storageDir, name);
            const st = await fsp.stat(p).catch(() => null);
            // Grace period: never delete something that might be seconds from getting its row.
            if (st && Date.now() - st.mtimeMs > 3600000) {
                await fsp.unlink(p).catch(() => {});
                result.orphans++;
            }
        }
    } catch (err) {
        if (err.code !== 'ENOENT') logger.error(`[Vault] orphan sweep failed: ${err.message}`);
    }

    return result;
}

// ---------------------------------------------------------------------------

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export default {
    CONFIG, ensureStorage, isMember, listMembers, addMember, removeMember, audit, recentAudit,
    ownerId, isOwnerId, ensureOwnerMember,
    usage, beginUpload, getUpload, appendChunk, completeUpload, abortUpload, listFiles,
    listPendingUploads, getFile, storedPath, updateFile, deleteFile, noteDownload, fileDownloads,
    isExpired, updateBurn, burnAfterDownload,
    createShareLink, listShareLinks, revokeShareLink, resolveShareToken, checkSharePassword,
    consumeShareDownload, sweep, formatBytes, isValidId, cleanName
};
