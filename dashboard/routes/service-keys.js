/**
 * Super-admin "Service keys" page — set specific .env secrets from the dashboard, phone-friendly.
 *
 *   GET  /super-admin/service-keys                 the page (super-admin only)
 *   GET  /api/super-admin/service-keys             per-key SET/NOT-SET + last change + recent audit (never a value)
 *   POST /api/super-admin/service-keys/:key        set one key   -> { ok:true, set:true }
 *   POST /api/super-admin/service-keys/:key/clear  unset one key -> { ok:true, set:false }
 *
 * SECURITY CONTRACT:
 *   - Only the keys in ALLOWED_KEYS can be written; anything else is rejected (400). The list is a
 *     small config array so adding a key is one entry.
 *   - A value is NEVER rendered back, logged, or returned in JSON. The GET API reports a boolean
 *     SET / NOT SET only. The POST handler reads the value from the request body, writes it via
 *     utils/env-file.js (text edit, never `source`), and responds with { ok:true, set:true } — the
 *     value appears in no response and no log line.
 *   - Each change is recorded in service_key_audit (migration 474): key name, SET or CLEARED, the
 *     super-admin's id and the time. No value.
 *
 * After a successful write the new value is also applied to process.env in this running process, so
 * code that reads process.env at call-time picks it up immediately. Keys whose consumers captured
 * the value into a module-load constant still need a pm2 restart to fully take effect — that is
 * flagged per key below (`restart`) and shown on the page.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { checkAuth, checkSuperAdmin, apiCheckSuperAdmin } from '../middleware/auth.js';
import { setEnvValue, clearEnvValue, isKeySet } from '../../utils/env-file.js';

/**
 * The only keys this page may write. Each: the .env key, a label, help text, a validation regex
 * (string; the value is trimmed, must contain no whitespace, and must match), and how the running
 * process picks up a change:
 *   restart: 'none'        read from process.env at call-time — live the moment it is saved
 *   restart: 'recommended' live for most paths, but one consumer captures it at startup — restart to be safe
 *   restart: 'required'    a consumer reads it into a module-load constant — a pm2 restart is needed
 */
export const ALLOWED_KEYS = [
    {
        key: 'GOOGLE_OAUTH_CLIENT_ID',
        label: 'Google OAuth client ID',
        help: 'The stream bot’s Google sign-in client ID. Ends with .apps.googleusercontent.com.',
        group: 'Google (YouTube stream bot)',
        pattern: '^[A-Za-z0-9-]+\\.apps\\.googleusercontent\\.com$',
        restart: 'recommended',
        restartNote: 'Live for the bot’s YouTube config and the viewer privacy page. The dashboard’s “Link YouTube” (stream-connect) flow reads it once at startup, so restart to fully apply.',
    },
    {
        key: 'GOOGLE_OAUTH_CLIENT_SECRET',
        label: 'Google OAuth client secret',
        help: 'The matching Google client secret (starts GOCSPX-). No spaces or line breaks.',
        group: 'Google (YouTube stream bot)',
        pattern: '^GOCSPX-[A-Za-z0-9._-]+$',
        restart: 'recommended',
        restartNote: 'Same as the client ID: live for the bot and privacy page; restart to update the dashboard stream-connect flow.',
    },
    {
        key: 'R2_ACCOUNT_ID',
        label: 'Cloudflare R2 account ID',
        help: 'For the nightly off-site backup to R2. Your Cloudflare account ID (32 hex characters).',
        group: 'Cloudflare R2 (backups)',
        pattern: '^[A-Fa-f0-9]{32}$',
        restart: 'none',
        restartNote: 'Read from .env by scripts/backup/r2-offsite.sh at each nightly run (10:00 UTC) — live on save, no restart.',
    },
    {
        key: 'R2_ACCESS_KEY_ID',
        label: 'Cloudflare R2 access key ID',
        help: 'For the nightly off-site backup to R2. The R2 access key ID (32 hex characters).',
        group: 'Cloudflare R2 (backups)',
        pattern: '^[A-Fa-f0-9]{32}$',
        restart: 'none',
        restartNote: 'Read from .env by scripts/backup/r2-offsite.sh at each nightly run (10:00 UTC) — live on save, no restart.',
    },
    {
        key: 'R2_SECRET_ACCESS_KEY',
        label: 'Cloudflare R2 secret access key',
        help: 'For the nightly off-site backup to R2. The R2 secret access key (64 hex characters).',
        group: 'Cloudflare R2 (backups)',
        pattern: '^[A-Fa-f0-9]{64}$',
        restart: 'none',
        restartNote: 'Read from .env by scripts/backup/r2-offsite.sh at each nightly run (10:00 UTC) — live on save, no restart.',
    },
    {
        key: 'R2_BUCKET',
        label: 'R2 bucket name',
        help: 'The R2 bucket the nightly off-site backup writes to (lowercase letters, digits and hyphens, 3-63 characters).',
        group: 'Cloudflare R2 (backups)',
        pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$',
        restart: 'none',
        restartNote: 'Read from .env by scripts/backup/r2-offsite.sh at each nightly run (10:00 UTC) — live on save, no restart.',
    },
    {
        key: 'GIPHY_API_KEY',
        label: 'Giphy API key',
        help: 'Powers GIF cards. Alphanumeric.',
        group: 'Rotatable keys',
        pattern: '^[A-Za-z0-9]{24,}$',
        restart: 'none',
        restartNote: 'Read from process.env when a GIF is fetched — live immediately.',
    },
    {
        key: 'ITAD_API_KEY',
        label: 'IsThereAnyDeal API key',
        help: 'Game deals lookups. Hexadecimal.',
        group: 'Rotatable keys',
        pattern: '^[A-Fa-f0-9]{16,}$',
        restart: 'required',
        restartNote: 'The /deals command reads it into a constant at startup, so a pm2 restart is needed.',
    },
    {
        key: 'RAPIDAPI_KEY',
        label: 'RapidAPI key',
        help: 'Used by code/tools lookups. Long alphanumeric string.',
        group: 'Rotatable keys',
        pattern: '^[A-Za-z0-9]{40,}$',
        restart: 'required',
        restartNote: 'The code tools handler reads it into a constant at startup, so a pm2 restart is needed.',
    },
    {
        key: 'STEAM_API_KEY',
        label: 'Steam Web API key',
        help: 'Steam library sync and lookups. 32 hex characters.',
        group: 'Rotatable keys',
        pattern: '^[A-Fa-f0-9]{32}$',
        restart: 'none',
        restartNote: 'Read from process.env on each Steam call — live immediately.',
    },
    {
        key: 'KICK_CLIENT_SECRET',
        label: 'Kick client secret',
        help: 'Kick OAuth / webhooks. No spaces or line breaks.',
        group: 'Rotatable keys',
        pattern: '^[A-Za-z0-9._-]{20,}$',
        restart: 'none',
        restartNote: 'Read from process.env at each Kick token exchange — live immediately.',
    },
    {
        key: 'LASTFM_API_KEY',
        label: 'Last.fm API key',
        help: 'Last.fm now-playing / scrobbles. 32 hex characters.',
        group: 'Rotatable keys',
        pattern: '^[A-Fa-f0-9]{32}$',
        restart: 'recommended',
        restartNote: 'New auth reads it live, but a long-lived Last.fm client may have captured it at startup — restart to be safe.',
    },
    {
        key: 'LASTFM_SHARED_SECRET',
        label: 'Last.fm shared secret',
        help: 'The Last.fm shared secret that signs requests. 32 hex characters.',
        group: 'Rotatable keys',
        pattern: '^[A-Fa-f0-9]{32}$',
        restart: 'recommended',
        restartNote: 'New auth reads it live, but a long-lived Last.fm client may have captured it at startup — restart to be safe.',
    },
];

/** Public shape of a config entry (no value, no raw regex needed by the browser). */
function publicMeta(def) {
    return { key: def.key, label: def.label, help: def.help, group: def.group, restart: def.restart, restartNote: def.restartNote };
}

/**
 * Build the Service keys router.
 *   envPath / backupDir  override the .env and backup locations (tests point these at a temp file).
 *   db                   the database pool (tests inject a fake so the audit table is never touched).
 */
export function createServiceKeysRouter({ envPath, backupDir, db = pool } = {}) {
    const router = express.Router();
    const fileOpts = {};
    if (envPath) fileOpts.envPath = envPath;
    if (backupDir) fileOpts.backupDir = backupDir;
    const BY_KEY = new Map(ALLOWED_KEYS.map(k => [k.key, k]));

    // Record a change. Never includes a value. Never throws (a failed audit must not fail the write).
    async function recordAudit(keyName, action, user) {
        try {
            await db.execute(
                'INSERT INTO service_key_audit (key_name, action, actor_id, actor_name) VALUES (?, ?, ?, ?)',
                [keyName, action, String(user?.id || ''), user?.username || user?.global_name || null]
            );
        } catch (err) {
            if (err.code !== 'ER_NO_SUCH_TABLE') logger.warn('[ServiceKeys] Could not write audit row', { key: keyName, action, error: err.message });
        }
    }

    // Newest audit row per key plus the most recent N overall. Tolerant: any DB problem -> empty.
    async function loadAudit(limit = 8) {
        try {
            const [latest] = await db.query(
                `SELECT a.key_name, a.action, a.actor_id, a.actor_name, a.created_at
                   FROM service_key_audit a
                   JOIN (SELECT key_name, MAX(id) AS max_id FROM service_key_audit GROUP BY key_name) m
                     ON m.max_id = a.id`
            );
            const [recent] = await db.query(
                'SELECT key_name, action, actor_id, actor_name, created_at FROM service_key_audit ORDER BY id DESC LIMIT ?',
                [limit]
            );
            const byKey = {};
            for (const r of latest) byKey[r.key_name] = { action: r.action, actorId: r.actor_id, actorName: r.actor_name, at: r.created_at };
            return { byKey, recent };
        } catch (err) {
            if (err.code !== 'ER_NO_SUCH_TABLE') logger.warn('[ServiceKeys] Could not read audit', { error: err.message });
            return { byKey: {}, recent: [], auditMissing: true };
        }
    }

    // ── Page ──────────────────────────────────────────────────────────────────
    router.get('/super-admin/service-keys', checkAuth, checkSuperAdmin, (req, res) => {
        res.render('super-admin-service-keys', { user: req.user });
    });

    // ── State (boolean SET / NOT SET + last change + recent audit; never a value) ─
    router.get('/api/super-admin/service-keys', apiCheckSuperAdmin, async (req, res) => {
        try {
            const audit = await loadAudit();
            const keys = ALLOWED_KEYS.map(def => ({
                ...publicMeta(def),
                set: isKeySet(def.key, fileOpts),
                lastChange: audit.byKey[def.key] || null,
            }));
            res.set('Cache-Control', 'no-store').json({ now: Date.now(), keys, recent: audit.recent, auditMissing: !!audit.auditMissing });
        } catch (error) {
            logger.error('[ServiceKeys] state API error', { error: error.message });
            res.status(500).json({ error: 'Could not load service keys' });
        }
    });

    // ── Set one key ─────────────────────────────────────────────────────────────
    router.post('/api/super-admin/service-keys/:key', apiCheckSuperAdmin, async (req, res) => {
        const def = BY_KEY.get(req.params.key);
        if (!def) return res.status(400).json({ ok: false, error: 'Not a settable key.' });

        // Read the value from the body and immediately trim it. It is never echoed, logged or returned.
        const raw = req.body?.value;
        if (typeof raw !== 'string') return res.status(400).json({ ok: false, error: 'A value is required.' });
        const value = raw.replace(/^﻿/, '').replace(/[\s﻿]+$/u, '');

        if (value.length === 0) return res.status(400).json({ ok: false, error: 'The value is empty.' });
        if (/\s/.test(value)) return res.status(400).json({ ok: false, error: 'The value must not contain spaces or line breaks.' });
        let re = null;
        try { re = new RegExp(def.pattern); } catch { re = null; }
        if (re && !re.test(value)) return res.status(400).json({ ok: false, error: `That does not look like a valid ${def.label}.` });

        try {
            setEnvValue(def.key, value, fileOpts); // text edit + backup + atomic write; throws without the value
            process.env[def.key] = value;          // live for call-time readers in this process
        } catch (err) {
            logger.error('[ServiceKeys] write failed', { key: def.key, code: err.code, message: err.message }); // message carries no value by construction
            return res.status(500).json({ ok: false, error: 'Could not write the key. Check the server logs.' });
        }

        logger.info('[ServiceKeys] key set', { key: def.key, by: req.user.id });
        await recordAudit(def.key, 'set', req.user);
        return res.json({ ok: true, set: true });
    });

    // ── Clear one key ───────────────────────────────────────────────────────────
    router.post('/api/super-admin/service-keys/:key/clear', apiCheckSuperAdmin, async (req, res) => {
        const def = BY_KEY.get(req.params.key);
        if (!def) return res.status(400).json({ ok: false, error: 'Not a settable key.' });

        try {
            clearEnvValue(def.key, fileOpts);
            delete process.env[def.key];
        } catch (err) {
            logger.error('[ServiceKeys] clear failed', { key: def.key, code: err.code, message: err.message });
            return res.status(500).json({ ok: false, error: 'Could not clear the key. Check the server logs.' });
        }

        logger.info('[ServiceKeys] key cleared', { key: def.key, by: req.user.id });
        await recordAudit(def.key, 'cleared', req.user);
        return res.json({ ok: true, set: false });
    });

    return router;
}

export default createServiceKeysRouter();
