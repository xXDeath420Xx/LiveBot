/*
 * Stream bot import from Firebot and Streamer.bot (docs/superpowers/specs/2026-11-19-stream-bot-design.md §6).
 *
 *   readUpload({ name, buffer, wantViewers }) → { bundle, skipped: [{ path, reason }], kind }   throws ImportError
 *       Accepts: a Firebot setup (.firebotsetup JSON), a zipped Firebot profile folder, a Streamer.bot import string
 *       or .sb file (text), a Streamer.bot export JSON, a zipped Streamer.bot data folder. Programs and scripts are
 *       refused or skipped unread; credentials are stripped by the parsers and once more here, and a bundle that
 *       still scans as holding one is refused.
 *   createImportService({ store, importStore, db, logger }) → { preview, clear, getPreview, run, … } for the route
 *
 * Module map: zip.js (ZIP reader), secrets.js (strip and scan), variables.js (variable translation), catalog.js
 * (gaps, integrations, categories), firebot.js / streamerbot.js (parsers → bundle), mapper.js (bundle → plan),
 * report.js (what the page shows), apply.js (writes, idempotent), privacy.js (/privacy export rows).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readZip, isZip, looksExecutable, ImportError } from './zip.js';
import { stripSecrets, scanForSecrets } from './secrets.js';
import { parseFirebot } from './firebot.js';
import { parseStreamerbot, decodeImportString } from './streamerbot.js';
import { buildPlan } from './mapper.js';
import { reportOf } from './report.js';
import { applyPlan } from './apply.js';

export { ImportError };
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const PREVIEW_TTL_MS = 30 * 60 * 1000;

const text = (b) => b.toString('utf8').replace(/^﻿/, '');
/** Firebot and Streamer.bot files that hold nothing but logins and tokens. */
export const CREDENTIAL_FILES = /(^|\/)(auth[^/]*\.json|auth\.db|twitch_data\.db|kick_data\.db|youtube_data\.db|trovo_data\.db|[^/]*\.bak)$/i;

/** Firebot keeps quotes in SQLite (databases/quotes.db + -wal). Read them from a private temp copy. */
async function firebotQuotes(files) {
    const key = [...files.keys()].find((p) => /(^|\/)databases\/quotes\.db$/i.test(p));
    if (!key) return [];
    let Database;
    try { Database = (await import('better-sqlite3')).default; } catch { return []; }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbimp-'));
    try {
        const dbPath = path.join(dir, 'quotes.db');
        await fs.writeFile(dbPath, files.get(key), { mode: 0o600 });
        const wal = files.get(`${key}-wal`);
        if (wal) await fs.writeFile(`${dbPath}-wal`, wal, { mode: 0o600 });
        const db = new Database(dbPath, { fileMustExist: true });
        try {
            const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quotes'").get();
            return has ? db.prepare('SELECT id, text, originator, creator, game, created_at FROM quotes LIMIT 5000').all() : [];
        } finally { db.close(); }
    } catch {
        return [];
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** What kind of upload is this, and parse it. */
export async function readUpload({ name = '', buffer, wantViewers = false } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ImportError('empty', 'Choose a file, or paste a Streamer.bot import string.');
    if (buffer.length > UPLOAD_MAX_BYTES) throw new ImportError('too_big', `The upload is larger than ${UPLOAD_MAX_BYTES / 1048576} MB.`);
    if (looksExecutable(buffer)) throw new ImportError('executable', 'That is a program or a script, not a Firebot or Streamer.bot export.');
    let bundle, kind, skipped = [];
    if (isZip(buffer)) {
        const z = readZip(buffer);
        skipped = z.skipped;
        // Files that only hold logins and tokens are dropped unread.
        for (const p of [...z.files.keys()]) {
            if (CREDENTIAL_FILES.test(p)) { z.files.delete(p); skipped.push({ path: p, reason: 'holds logins or tokens (not read)' }); }
        }
        const paths = [...z.files.keys()];
        const isFirebot = paths.some((p) => /(^|\/)(chat\/commands\.json|events\/events\.json|counters\/counters\.json|channel-rewards\.json)$/i.test(p));
        const isSb = paths.some((p) => /(^|\/)(actions\.json|twitch_rewards\.json|users\.dat)$/i.test(p));
        if (isFirebot && !isSb) {
            kind = 'firebot-profile';
            bundle = parseFirebot({ files: z.files, quotes: await firebotQuotes(z.files), wantViewers });
        } else if (isSb && !isFirebot) {
            kind = 'streamerbot-data';
            bundle = parseStreamerbot({ files: z.files, wantViewers });
        } else if (isSb && isFirebot) {
            throw new ImportError('both', 'That archive holds both a Firebot profile and a Streamer.bot data folder. Upload them one at a time.');
        } else {
            throw new ImportError('unknown_zip', 'That archive has neither a Firebot profile (chat/commands.json, events/events.json) nor a Streamer.bot data folder (actions.json).');
        }
    } else {
        const s = text(buffer).trim();
        let obj = null;
        if (s.startsWith('{')) {
            try { obj = JSON.parse(s); } catch { throw new ImportError('bad_json', 'That file is not valid JSON.'); }
        }
        if (obj && (obj.components || /\.firebotsetup$/i.test(name))) {
            kind = 'firebot-setup';
            bundle = parseFirebot({ setup: obj, wantViewers });
        } else if (obj && (obj.data?.actions || obj.actions || obj.meta)) {
            kind = 'streamerbot-export';
            bundle = parseStreamerbot({ exported: obj, wantViewers });
        } else if (!obj) {
            kind = 'streamerbot-export';
            bundle = parseStreamerbot({ exported: decodeImportString(s), wantViewers });
        } else {
            throw new ImportError('unknown_json', 'That JSON is neither a Firebot setup nor a Streamer.bot export.');
        }
    }
    // Defence in depth: strip once more over the whole bundle, then refuse anything that still looks like a credential.
    const again = stripSecrets(bundle);
    const clean = again.value;
    clean.stripped = { fields: (bundle.stripped?.fields || 0) + again.stripped.fields, values: (bundle.stripped?.values || 0) + again.stripped.values };
    const leaks = scanForSecrets(clean);
    if (leaks.length) throw new ImportError('secrets', `The file still holds ${leaks.length} values that look like passwords or tokens after cleaning, so it was not read. Export it again without them.`);
    return { bundle: clean, kind, skipped };
}

/** Per-profile pending previews (one bundle per source), kept in memory for 30 minutes. */
export function createPreviewCache({ ttlMs = PREVIEW_TTL_MS, now = () => Date.now(), max = 500 } = {}) {
    const map = new Map();
    const sweep = () => {
        for (const [k, v] of map) if (now() - v.at > ttlMs) map.delete(k);
        while (map.size > max) map.delete(map.keys().next().value);
    };
    return {
        get(profileId) { sweep(); return map.get(profileId) || null; },
        add(profileId, { bundle, fileName, kind, skipped }) {
            sweep();
            const cur = map.get(profileId) || { id: crypto.randomBytes(6).toString('hex'), bundles: {}, files: {}, at: now() };
            cur.bundles[bundle.source] = bundle;
            cur.files[bundle.source] = { name: String(fileName || '').slice(0, 120), kind, skipped: (skipped || []).slice(0, 200) };
            cur.at = now();
            map.set(profileId, cur);
            return cur;
        },
        clear(profileId) { map.delete(profileId); },
    };
}

/** Built-in channel command names (and their default aliases): an import never shadows one. */
export async function channelBuiltins(db) {
    const out = new Set();
    try {
        const [rows] = await db.query('SELECT command_key, default_aliases FROM tokes_global_command_config');
        for (const r of rows) {
            out.add(String(r.command_key).toLowerCase());
            let a = r.default_aliases;
            try { a = typeof a === 'string' ? JSON.parse(a) : a; } catch { a = []; }
            for (const x of Array.isArray(a) ? a : []) out.add(String(x).toLowerCase());
        }
    } catch { /* table missing in tests */ }
    return out;
}

export function createImportService({ store, importStore, db, cache = createPreviewCache() } = {}) {
    async function context(profileId, { wantViewers = false } = {}) {
        const channels = (await store.listChannels(profileId)).map((c) => ({ platform: c.platform, platformUserId: c.platform_user_id, login: c.login }));
        const channelBots = await importStore.channelBotsFor(channels);
        return { channels, channelBots, builtins: await channelBuiltins(db), wantViewers };
    }
    const order = (p) => ['firebot', 'streamerbot'].map((s) => p.bundles[s]).filter(Boolean);
    return {
        cache,
        context,
        async upload(profileId, { name, buffer, wantViewers = false }) {
            // Viewer rows are read into the preview so ticking Viewer stats later needs no new upload; they are only
            // written when the box is ticked.
            const r = await readUpload({ name, buffer, wantViewers: true });
            const p = cache.add(profileId, { bundle: r.bundle, fileName: name, kind: r.kind, skipped: r.skipped });
            return this.preview(profileId, { wantViewers, pending: p });
        },
        async preview(profileId, { wantViewers = false, pending = null } = {}) {
            const p = pending || cache.get(profileId);
            if (!p) return null;
            const plan = buildPlan(order(p), await context(profileId, { wantViewers }));
            const report = reportOf(plan);
            return { id: p.id, files: p.files, stripped: Object.fromEntries(Object.entries(p.bundles).map(([k, b]) => [k, b.stripped])), report,
                viewers: Object.fromEntries(Object.entries(p.bundles).map(([k, b]) => [k, b.viewers ? { count: b.viewers.count, fields: b.viewers.fields } : null])) };
        },
        clear(profileId) { cache.clear(profileId); },
        async run(profileId, { categories, wantViewers = false, channelPageHref }) {
            const p = cache.get(profileId);
            if (!p) return null;
            const plan = buildPlan(order(p), await context(profileId, { wantViewers }));
            const sources = order(p).map((b) => b.source).join(',');
            const fileNames = Object.values(p.files).map((f) => f.name).filter(Boolean).join(', ');
            const out = await applyPlan({ store, importStore, profileId, plan, categories, meta: { sources, fileNames }, channelPageHref });
            cache.clear(profileId);
            return out;
        },
    };
}

export default { readUpload, createImportService, createPreviewCache, channelBuiltins, ImportError, UPLOAD_MAX_BYTES };
