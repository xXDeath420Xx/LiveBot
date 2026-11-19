/*
 * Vault - private encrypted-in-transit file transfer for a named allowlist.
 *
 * Mounted at /vault, NOT under /api, on purpose: the global apiLimiter is 60 requests a minute
 * and skips only super-admins. A 5 GB upload is hundreds of chunk requests, and Bear is not a
 * super-admin, so routing this through /api would rate-limit the second member out of their own
 * uploads. This router brings its own limiters instead - loose for chunks, tight for the public
 * share endpoints where a token or password could be brute-forced.
 *
 * Access model, in order of strictness:
 *   requireMember  - a Discord session whose id is in vault_members. Everything by default.
 *   requireOwner   - BOT_OWNER_ID itself. Only for editing the allowlist.
 *   share token    - a 256-bit capability URL, optionally password-gated, always expiring.
 *                    Grants exactly one thing: downloading one file.
 *
 * Downloads are ALWAYS sent as application/octet-stream with nosniff, never the uploaded
 * content type. certifriedmultitool.com serves the dashboard from this same origin, so a stored
 * .html or .svg served inline would be script running with the session cookie of whoever opened
 * it. There is no preview feature here for exactly that reason.
 */

import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import vault from '../../core/vault-manager.js';

const router = express.Router();

const clientIp = (req) =>
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip;

const auditCtx = (req) => ({
    ip: clientIp(req),
    userAgent: req.headers['user-agent']
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

async function loadMember(req) {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user?.id) return false;
    return vault.isMember(req.user.id);
}

/** HTML routes: bounce an anonymous visitor to login, refuse a logged-in stranger. */
async function requireMemberPage(req, res, next) {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/auth/discord');
    }
    if (await loadMember(req)) return next();
    logger.warn(`[Vault] denied page access to ${req.user.id} (${req.user.username})`);
    await vault.audit({ actorId: req.user.id, action: 'denied', detail: req.originalUrl, ...auditCtx(req) });
    return res.status(404).render('error-tailwind', {
        user: req.user,
        error: 'Not found.'
    });
}

/** JSON routes. */
async function requireMemberApi(req, res, next) {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({ error: 'Sign in first.' });
    }
    if (await loadMember(req)) return next();
    await vault.audit({ actorId: req.user.id, action: 'denied', detail: req.originalUrl, ...auditCtx(req) });
    return res.status(403).json({ error: 'You do not have vault access.' });
}

/*
 * Who may edit the allowlist. Deliberately BOT_OWNER_ID alone, not isSuperAdmin().
 *
 * isSuperAdmin() is a network-wide grant and utils/constants.js hardcodes a second id into it.
 * That made "only the vault owner can change the member list" false in practice, and on
 * 2026-09-07 the second super-admin used it to remove the owner from his own vault. Who can
 * open this vault is the owner's call and nobody else's.
 */
function requireOwner(req, res, next) {
    if (req.user && vault.isOwnerId(req.user.id)) return next();
    return res.status(403).json({ error: 'Only the vault owner can change the member list.' });
}

// ---------------------------------------------------------------------------
// Limiters
// ---------------------------------------------------------------------------

// Chunked uploads are chatty by design. 16 MB slices means ~320 requests for a 5 GB file, and a
// proxy that forces a fallback to 1 MB means ~5000. Keyed per user, not per IP, so two members
// behind one connection do not throttle each other.
const memberLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || clientIp(req),
    message: { error: 'Slow down.' }
});

// The public side. A share token is unguessable, but a password on one is only as good as the
// number of attempts allowed.
const shareLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    message: 'Too many requests.'
});

const unlockLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    message: 'Too many attempts. Wait a few minutes.'
});

// ---------------------------------------------------------------------------
// Streaming a file out
// ---------------------------------------------------------------------------

/** RFC 5987: an ASCII fallback plus a UTF-8 form, so unicode names survive. */
function dispositionHeader(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/*
 * Stream a file out, and tell the caller whether the transfer actually finished.
 *
 * "Finished" is deliberately strict: the response has to have flushed every byte it promised
 * AND the range served has to reach the last byte of the file. Anything less is someone who
 * started a download and gave up, which must never be allowed to burn a burn-after-download
 * file. Getting this wrong turns a flaky connection into silent data loss.
 */
async function sendFile(req, res, file, onFinish) {
    const path = vault.storedPath(file.file_id);
    let stat;
    try {
        stat = await fsp.stat(path);
    } catch {
        logger.error(`[Vault] row ${file.file_id} has no file on disk`);
        return res.status(410).send('That file is no longer on disk.');
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', dispositionHeader(file.original_name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    let start = 0;
    let end = stat.size - 1;

    // Range support is what lets a browser resume a 5 GB download that dropped at 80%.
    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
        let s0 = m[1] === '' ? null : parseInt(m[1], 10);
        let e0 = m[2] === '' ? null : parseInt(m[2], 10);
        if (s0 === null) {
            // Suffix range: the last N bytes.
            s0 = Math.max(0, stat.size - (e0 || 0));
            e0 = stat.size - 1;
        } else if (e0 === null || e0 >= stat.size) {
            e0 = stat.size - 1;
        }
        if (s0 > e0 || s0 >= stat.size) {
            res.setHeader('Content-Range', `bytes */${stat.size}`);
            return res.status(416).end();
        }
        start = s0;
        end = e0;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    }

    const expected = end - start + 1;
    const reachesEnd = end === stat.size - 1;
    res.setHeader('Content-Length', expected);

    // A HEAD is a question, not a download. It transfers nothing and must never count.
    if (req.method === 'HEAD') return res.end();

    let sent = 0;
    let settled = false;
    let streamEnded = false;

    /*
     * The completion signal is the READ stream reaching its end, not res.writableFinished.
     *
     * writableFinished looks like the obvious answer and is wrong: on a small response the
     * client closes the socket the instant it has the bytes, so 'close' fires before 'finish'
     * and the flag is still false at the only moment we get to look at it. Measured: a 1 KB
     * range that transferred perfectly reported writableFinished=false, which would mean a
     * burn-after-download file could never be burned by a small download.
     *
     * streamEnded says we handed every promised byte to the response. We decide at 'close', so
     * the exchange is genuinely over by then. The remaining gap is bytes sitting in the socket
     * buffer when a client disappears in the last instant - a window of at most a buffer's
     * worth, against the alternative of getting every short transfer wrong.
     */
    const settle = () => {
        if (settled) return;
        settled = true;
        const complete = streamEnded && sent >= expected && reachesEnd;
        Promise.resolve(onFinish?.({ complete, bytes: sent, expected }))
            .catch(err => logger.error(`[Vault] post-download hook failed: ${err.message}`));
    };
    res.on('close', settle);
    res.on('finish', settle);

    const stream = fs.createReadStream(path, { start, end });
    stream.on('data', (chunk) => { sent += chunk.length; });
    stream.on('end', () => { streamEnded = true; });
    stream.on('error', (err) => {
        logger.error(`[Vault] read stream failed for ${file.file_id}: ${err.message}`);
        res.destroy();
    });
    return stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

router.get('/vault', requireMemberPage, async (req, res) => {
    try {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.render('vault', {
            user: req.user,
            isOwner: vault.isOwnerId(req.user.id),
            config: {
                maxFileBytes: vault.CONFIG.maxFileBytes,
                maxTotalBytes: vault.CONFIG.maxTotalBytes,
                chunkBytes: vault.CONFIG.chunkBytes,
                retentionMinutes: vault.CONFIG.retentionMinutes,
                maxShareDays: vault.CONFIG.maxShareDays
            }
        });
    } catch (err) {
        logger.error(`[Vault] page render failed: ${err.message}`);
        res.status(500).send('Error loading the vault.');
    }
});

// ---------------------------------------------------------------------------
// Member API
// ---------------------------------------------------------------------------

router.use('/vault/api', memberLimiter);

router.get('/vault/api/state', requireMemberApi, async (req, res) => {
    try {
        const [usage, files, pending, members] = await Promise.all([
            vault.usage(),
            vault.listFiles(),
            vault.listPendingUploads(req.user.id),
            vault.listMembers()
        ]);

        // Best-effort display names. A member who shares no guild with any bot simply shows
        // their id, which is still unambiguous.
        const client = req.app.locals.client;
        const named = await Promise.all(members.map(async (m) => {
            let username = null;
            try {
                username = (await client?.users?.fetch(m.user_id))?.username || null;
            } catch { /* unknown to us; the id stands on its own */ }
            return { ...m, username };
        }));

        res.json({
            me: { id: req.user.id, username: req.user.username },
            isOwner: vault.isOwnerId(req.user.id),
            usage,
            files,
            pending,
            members: named
        });
    } catch (err) {
        logger.error(`[Vault] state failed: ${err.message}`);
        res.status(500).json({ error: 'Could not load the vault.' });
    }
});

router.post('/vault/api/uploads', requireMemberApi, async (req, res) => {
    try {
        const { name, size, contentType, note, retentionMinutes, deleteOnDownload } = req.body || {};
        const out = await vault.beginUpload({
            ownerId: req.user.id, name, size, contentType, note, retentionMinutes, deleteOnDownload
        });
        if (out.error) return res.status(out.status || 400).json({ error: out.error });
        await vault.audit({
            actorId: req.user.id, action: 'upload_start',
            detail: `${vault.cleanName(name)} (${vault.formatBytes(size)})`, ...auditCtx(req)
        });
        res.json(out);
    } catch (err) {
        logger.error(`[Vault] beginUpload failed: ${err.message}`);
        res.status(500).json({ error: 'Could not start the upload.' });
    }
});

router.get('/vault/api/uploads/:id', requireMemberApi, async (req, res) => {
    const row = await vault.getUpload(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Upload not found.' });
    res.json({
        uploadId: row.upload_id,
        offset: Number(row.received_bytes),
        size: Number(row.size_bytes),
        name: row.original_name,
        chunkBytes: vault.CONFIG.chunkBytes
    });
});

/*
 * The chunk endpoint. Body is raw bytes; the global body parser leaves
 * application/octet-stream alone, so `req` arrives here as an unread stream and is piped
 * straight to disk - nothing buffers 16 MB in memory, let alone 5 GB.
 */
router.patch('/vault/api/uploads/:id', requireMemberApi, async (req, res) => {
    const claimed = Number(req.headers['x-upload-offset']);
    if (!Number.isFinite(claimed) || claimed < 0) {
        return res.status(400).json({ error: 'X-Upload-Offset header required.' });
    }
    try {
        const out = await vault.appendChunk({
            uploadId: req.params.id,
            ownerId: req.user.id,
            claimedOffset: claimed,
            stream: req,
            maxChunkBytes: vault.CONFIG.chunkBytes * 4
        });
        if (out.error) {
            return res.status(out.status || 400).json({ error: out.error, offset: out.offset });
        }
        res.json(out);
    } catch (err) {
        logger.error(`[Vault] chunk failed: ${err.message}`);
        res.status(500).json({ error: 'Chunk write failed.' });
    }
});

router.post('/vault/api/uploads/:id/complete', requireMemberApi, async (req, res) => {
    try {
        const out = await vault.completeUpload({ uploadId: req.params.id, ownerId: req.user.id });
        if (out.error) return res.status(out.status || 400).json({ error: out.error, offset: out.offset });
        const file = await vault.getFile(out.fileId);
        await vault.audit({
            actorId: req.user.id, action: 'upload', fileId: out.fileId,
            detail: `${file.original_name} (${vault.formatBytes(file.size_bytes)})`, ...auditCtx(req)
        });
        res.json({ file });
    } catch (err) {
        logger.error(`[Vault] complete failed: ${err.message}`);
        res.status(500).json({ error: 'Could not finalise the upload.' });
    }
});

router.delete('/vault/api/uploads/:id', requireMemberApi, async (req, res) => {
    const ok = await vault.abortUpload(req.params.id, req.user.id);
    res.json({ ok });
});

router.patch('/vault/api/files/:id', requireMemberApi, async (req, res) => {
    try {
        const file = await vault.getFile(req.params.id);
        if (!file) return res.status(404).json({ error: 'File not found.' });

        const patch = {};
        if (req.body?.note !== undefined) patch.note = req.body.note;
        if (req.body?.deleteOnDownload !== undefined) {
            patch.deleteOnDownload = !!req.body.deleteOnDownload;
        }
        if (req.body?.expiresInMinutes !== undefined) {
            const mins = req.body.expiresInMinutes;
            patch.expiresAt = (mins === null || mins === '' || Number(mins) === 0)
                ? null
                : new Date(Date.now() + Math.max(1, parseInt(mins, 10) || 1) * 60000);
        }
        await vault.updateFile(req.params.id, patch);
        res.json({ file: await vault.getFile(req.params.id) });
    } catch (err) {
        logger.error(`[Vault] update failed: ${err.message}`);
        res.status(500).json({ error: 'Could not update the file.' });
    }
});

router.delete('/vault/api/files/:id', requireMemberApi, async (req, res) => {
    try {
        const file = await vault.getFile(req.params.id);
        if (!file) return res.status(404).json({ error: 'File not found.' });
        await vault.deleteFile(req.params.id);
        await vault.audit({
            actorId: req.user.id, action: 'delete', fileId: req.params.id,
            detail: file.original_name, ...auditCtx(req)
        });
        res.json({ ok: true });
    } catch (err) {
        logger.error(`[Vault] delete failed: ${err.message}`);
        res.status(500).json({ error: 'Could not delete the file.' });
    }
});

/*
 * Who fetched this file, when, from where, and whether they actually got all of it. Attempts
 * that did not finish are included on purpose - "they started it twice and never completed it"
 * is exactly the sort of thing you want to be able to see.
 */
router.get('/vault/api/files/:id/downloads', requireMemberApi, async (req, res) => {
    if (!vault.isValidId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    try {
        const rows = await vault.fileDownloads(req.params.id);
        const client = req.app.locals.client;
        const names = new Map();
        const entries = await Promise.all(rows.map(async (r) => {
            if (r.actor_id && !names.has(r.actor_id)) {
                let username = null;
                try {
                    username = (await client?.users?.fetch(r.actor_id))?.username || null;
                } catch { /* not visible to any of our bots; the id stands alone */ }
                names.set(r.actor_id, username);
            }
            return { ...r, username: r.actor_id ? names.get(r.actor_id) : null };
        }));
        res.json({ entries });
    } catch (err) {
        logger.error(`[Vault] download log failed: ${err.message}`);
        res.status(500).json({ error: 'Could not load the download log.' });
    }
});

router.get('/vault/api/files/:id/links', requireMemberApi, async (req, res) => {
    if (!vault.isValidId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    res.json({ links: await vault.listShareLinks(req.params.id) });
});

router.post('/vault/api/files/:id/links', requireMemberApi, async (req, res) => {
    try {
        const { label, days, maxDownloads, password } = req.body || {};
        const out = await vault.createShareLink({
            fileId: req.params.id, createdBy: req.user.id, label, days, maxDownloads, password
        });
        if (out.error) return res.status(out.status || 400).json({ error: out.error });

        await vault.audit({
            actorId: req.user.id, action: 'link_create', fileId: req.params.id,
            detail: `expires ${out.expiresAt.toISOString()}${out.maxDownloads ? `, max ${out.maxDownloads}` : ''}${password ? ', password' : ''}`,
            ...auditCtx(req)
        });

        const base = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
        res.json({
            url: `${base}/vault/s/${out.token}`,
            expiresAt: out.expiresAt,
            maxDownloads: out.maxDownloads
        });
    } catch (err) {
        logger.error(`[Vault] link create failed: ${err.message}`);
        res.status(500).json({ error: 'Could not create the link.' });
    }
});

router.post('/vault/api/links/:tokenHash/revoke', requireMemberApi, async (req, res) => {
    const ok = await vault.revokeShareLink(req.params.tokenHash);
    if (ok) {
        await vault.audit({ actorId: req.user.id, action: 'link_revoke', detail: req.params.tokenHash.slice(0, 12), ...auditCtx(req) });
    }
    res.json({ ok });
});

router.get('/vault/api/audit', requireMemberApi, async (req, res) => {
    res.json({ entries: await vault.recentAudit(req.query.limit) });
});

router.post('/vault/api/members', requireMemberApi, requireOwner, async (req, res) => {
    const { userId, label } = req.body || {};
    if (!/^\d{17,20}$/.test(String(userId || ''))) {
        return res.status(400).json({ error: 'That is not a Discord user id.' });
    }
    await vault.addMember(String(userId), label, req.user.id);
    await vault.audit({ actorId: req.user.id, action: 'member_add', detail: String(userId), ...auditCtx(req) });
    res.json({ ok: true });
});

router.delete('/vault/api/members/:userId', requireMemberApi, requireOwner, async (req, res) => {
    if (vault.isOwnerId(req.params.userId)) {
        return res.status(400).json({ error: 'The vault owner is permanent and cannot be removed.' });
    }
    if (req.params.userId === req.user.id) {
        return res.status(400).json({ error: 'You cannot remove yourself.' });
    }
    const removed = await vault.removeMember(req.params.userId);
    if (!removed) return res.status(404).json({ error: 'That user is not on the list.' });
    await vault.audit({ actorId: req.user.id, action: 'member_remove', detail: req.params.userId, ...auditCtx(req) });
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Member download
// ---------------------------------------------------------------------------

router.get('/vault/files/:id/download', requireMemberPage, async (req, res) => {
    try {
        const file = await vault.getFile(req.params.id);
        if (!file) return res.status(404).send('Not found.');
        if (vault.isExpired(file)) return res.status(410).send('That file has expired.');

        const ctx = auditCtx(req);
        return sendFile(req, res, file, async ({ complete, bytes }) => {
            // Logged on completion, not on request, so the record says what actually happened.
            await vault.audit({
                actorId: req.user.id,
                action: 'download',
                fileId: file.file_id,
                detail: file.original_name,
                bytes,
                completed: complete,
                ...ctx
            });
            if (!complete) return;
            await vault.noteDownload(file.file_id);
            await vault.burnAfterDownload(file, { actorId: req.user.id, ...ctx });
        });
    } catch (err) {
        logger.error(`[Vault] download failed: ${err.message}`);
        res.status(500).send('Download failed.');
    }
});

// ---------------------------------------------------------------------------
// Public share links
// ---------------------------------------------------------------------------

/** Password clearance is per-session and per-link, and does not outlive the link. */
function isUnlocked(req, hash) {
    const until = req.session?.vaultUnlocked?.[hash];
    return typeof until === 'number' && until > Date.now();
}

function renderGone(res, reason) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(reason === 'expired' || reason === 'exhausted' ? 410 : 404)
        .render('vault-share', {
            state: reason, file: null, needsPassword: false, error: null,
            unlockUrl: '', downloadUrl: ''
        });
}

router.get('/vault/s/:token', shareLimiter, async (req, res) => {
    try {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Cache-Control', 'private, no-store');
        const out = await vault.resolveShareToken(req.params.token);
        if (out.error) return renderGone(res, out.error);

        const needsPassword = !!out.link.password_hash && !isUnlocked(req, out.link.token_hash);
        const base = `/vault/s/${encodeURIComponent(req.params.token)}`;
        res.render('vault-share', {
            state: 'ok',
            unlockUrl: `${base}/unlock`,
            downloadUrl: `${base}/download`,
            file: {
                name: out.file.original_name,
                size: out.file.size_bytes,
                sizeLabel: vault.formatBytes(out.file.size_bytes),
                sha256: out.file.sha256,
                note: out.file.note,
                expiresAt: out.link.expires_at,
                remaining: out.link.max_downloads === null
                    ? null
                    : out.link.max_downloads - out.link.download_count
            },
            needsPassword,
            error: null
        });
    } catch (err) {
        logger.error(`[Vault] share page failed: ${err.message}`);
        res.status(500).send('Error.');
    }
});

router.post('/vault/s/:token/unlock', unlockLimiter, async (req, res) => {
    try {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        const out = await vault.resolveShareToken(req.params.token);
        if (out.error) return renderGone(res, out.error);

        const ok = await vault.checkSharePassword(out.link, req.body?.password);
        if (!ok) {
            await vault.audit({
                action: 'share_password_fail', fileId: out.file.file_id,
                detail: out.link.token_hash.slice(0, 12), ...auditCtx(req)
            });
            const base = `/vault/s/${encodeURIComponent(req.params.token)}`;
            return res.status(401).render('vault-share', {
                state: 'ok',
                unlockUrl: `${base}/unlock`,
                downloadUrl: `${base}/download`,
                file: {
                    name: out.file.original_name,
                    size: out.file.size_bytes,
                    sizeLabel: vault.formatBytes(out.file.size_bytes),
                    sha256: out.file.sha256,
                    note: out.file.note,
                    expiresAt: out.link.expires_at,
                    remaining: out.link.max_downloads === null
                        ? null
                        : out.link.max_downloads - out.link.download_count
                },
                needsPassword: true,
                error: 'Wrong password.'
            });
        }

        req.session.vaultUnlocked = req.session.vaultUnlocked || {};
        // An hour is long enough to start a large download and short enough that a shared
        // browser does not stay unlocked.
        req.session.vaultUnlocked[out.link.token_hash] = Date.now() + 3600000;
        res.redirect(`/vault/s/${encodeURIComponent(req.params.token)}`);
    } catch (err) {
        logger.error(`[Vault] unlock failed: ${err.message}`);
        res.status(500).send('Error.');
    }
});

router.get('/vault/s/:token/download', shareLimiter, async (req, res) => {
    try {
        const out = await vault.resolveShareToken(req.params.token);
        if (out.error) return renderGone(res, out.error);

        if (out.link.password_hash && !isUnlocked(req, out.link.token_hash)) {
            return res.redirect(`/vault/s/${encodeURIComponent(req.params.token)}`);
        }

        // A ranged request is the browser resuming a download it already paid for; counting it
        // again would burn a single-use link on the resume.
        const isResume = !!req.headers.range && req.headers.range !== 'bytes=0-';
        if (!isResume && !await vault.consumeShareDownload(out.link.token_hash)) {
            return renderGone(res, 'exhausted');
        }

        const ctx = auditCtx(req);
        const who = out.link.label
            ? `via link "${out.link.label}"`
            : `via link ${out.link.token_hash.slice(0, 12)}`;

        return sendFile(req, res, out.file, async ({ complete, bytes }) => {
            await vault.audit({
                action: 'share_download',
                fileId: out.file.file_id,
                detail: `${out.file.original_name} ${who}`,
                bytes,
                completed: complete,
                ...ctx
            });
            if (!complete) return;
            await vault.noteDownload(out.file.file_id);
            await vault.burnAfterDownload(out.file, ctx);
        });
    } catch (err) {
        logger.error(`[Vault] share download failed: ${err.message}`);
        res.status(500).send('Download failed.');
    }
});

export default router;
